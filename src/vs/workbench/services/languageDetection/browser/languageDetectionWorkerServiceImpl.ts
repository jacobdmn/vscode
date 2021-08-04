/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, DisposableStore, dispose, IDisposable, toDisposable } from 'vs/base/common/lifecycle';
import { ILanguageDetectionService } from 'vs/workbench/services/languageDetection/common/languageDetectionWorkerService';
import { FileAccess } from 'vs/base/common/network';
import { IWorkbenchEnvironmentService } from 'vs/workbench/services/environment/common/environmentService';
import { IConfigurationService } from 'vs/platform/configuration/common/configuration';
import { IModeService } from 'vs/editor/common/services/modeService';
import { URI } from 'vs/base/common/uri';
import { isWeb } from 'vs/base/common/platform';
import { registerSingleton } from 'vs/platform/instantiation/common/extensions';
import { LanguageDetectionSimpleWorker } from 'vs/workbench/services/languageDetection/browser/languageDetectionSimpleWorker';
import { DefaultWorkerFactory } from 'vs/base/worker/defaultWorkerFactory';
import { IModelService } from 'vs/editor/common/services/modelService';
import { IntervalTimer } from 'vs/base/common/async';
import { SimpleWorkerClient } from 'vs/base/common/worker/simpleWorker';
import { ITelemetryService } from 'vs/platform/telemetry/common/telemetry';

export class LanguageDetectionService extends Disposable implements ILanguageDetectionService {
	static readonly enablementSettingKey = 'workbench.editor.untitled.experimentalLanguageDetection';

	_serviceBrand: undefined;

	private _languageDetectionWorkerClient: LanguageDetectionWorkerClient;

	constructor(
		@IWorkbenchEnvironmentService private readonly _environmentService: IWorkbenchEnvironmentService,
		@IModeService private readonly _modeService: IModeService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@IModelService modelService: IModelService,
		@ITelemetryService telemetryService: ITelemetryService,
	) {
		super();

		this._languageDetectionWorkerClient = new LanguageDetectionWorkerClient(
			modelService,
			telemetryService,
			'languageDetectionWorkerService',
			// TODO: See if it's possible to bundle vscode-languagedetection
			this._environmentService.isBuilt && !isWeb
				? FileAccess.asBrowserUri('../../../../../../node_modules.asar/@vscode/vscode-languagedetection/dist/lib/index.js', require).toString(true)
				: FileAccess.asBrowserUri('../../../../../../node_modules/@vscode/vscode-languagedetection/dist/lib/index.js', require).toString(true),
			this._environmentService.isBuilt && !isWeb
				? FileAccess.asBrowserUri('../../../../../../node_modules.asar.unpacked/@vscode/vscode-languagedetection/model/model.json', require).toString(true)
				: FileAccess.asBrowserUri('../../../../../../node_modules/@vscode/vscode-languagedetection/model/model.json', require).toString(true),
			this._environmentService.isBuilt && !isWeb
				? FileAccess.asBrowserUri('../../../../../../node_modules.asar.unpacked/@vscode/vscode-languagedetection/model/group1-shard1of1.bin', require).toString(true)
				: FileAccess.asBrowserUri('../../../../../../node_modules/@vscode/vscode-languagedetection/model/group1-shard1of1.bin', require).toString(true));
	}

	public isEnabledForMode(modeId: string): boolean {
		return !!modeId && this._configurationService.getValue<boolean>(LanguageDetectionService.enablementSettingKey, { overrideIdentifier: modeId });
	}

	private getModeId(language: string | undefined): string | undefined {
		if (!language) {
			return undefined;
		}
		return this._modeService.getModeIdByFilepathOrFirstLine(URI.file(`file.${language}`)) ?? undefined;
	}

	async detectLanguage(resource: URI): Promise<string | undefined> {
		const language = await this._languageDetectionWorkerClient.detectLanguage(resource);
		if (language) {
			return this.getModeId(language);
		}
		return undefined;
	}

	async detectLanguages(resource: URI): Promise<string[]> {
		const languages: Array<string | undefined> = await this._languageDetectionWorkerClient.detectLanguages(resource);
		for (let i = 0; i < languages.length; i++) {
			const modeId = this.getModeId(languages[i]);
			languages[i] = modeId ? modeId : undefined;
		}

		return languages.filter(<T>(l?: T): l is T => Boolean(l));
	}
}

export interface IWorkerClient<W> {
	getProxyObject(): Promise<W>;
	dispose(): void;
}

class LanguageDetectionModelManager extends Disposable {
	private static STOP_SYNC_MODEL_DELTA_TIME_MS = 60 * 1000;
	private readonly _proxy: LanguageDetectionSimpleWorker;
	private readonly _modelService: IModelService;
	private _syncedModels: { [modelUrl: string]: IDisposable; } = Object.create(null);
	private _syncedModelsLastUsedTime: { [modelUrl: string]: number; } = Object.create(null);

	constructor(proxy: LanguageDetectionSimpleWorker, modelService: IModelService, keepIdleModels: boolean) {
		super();
		this._proxy = proxy;
		this._modelService = modelService;

		if (!keepIdleModels) {
			let timer = new IntervalTimer();
			timer.cancelAndSet(() => this._checkStopModelSync(), Math.round(LanguageDetectionModelManager.STOP_SYNC_MODEL_DELTA_TIME_MS / 2));
			this._register(timer);
		}
	}

	public override dispose(): void {
		for (let modelUrl in this._syncedModels) {
			dispose(this._syncedModels[modelUrl]);
		}
		this._syncedModels = Object.create(null);
		this._syncedModelsLastUsedTime = Object.create(null);
		super.dispose();
	}

	public ensureSyncedResources(resources: URI[]): void {
		for (const resource of resources) {
			let resourceStr = resource.toString();

			if (!this._syncedModels[resourceStr]) {
				this._beginModelSync(resource);
			}
			if (this._syncedModels[resourceStr]) {
				this._syncedModelsLastUsedTime[resourceStr] = (new Date()).getTime();
			}
		}
	}

	private _checkStopModelSync(): void {
		let currentTime = (new Date()).getTime();

		let toRemove: string[] = [];
		for (let modelUrl in this._syncedModelsLastUsedTime) {
			let elapsedTime = currentTime - this._syncedModelsLastUsedTime[modelUrl];
			if (elapsedTime > LanguageDetectionModelManager.STOP_SYNC_MODEL_DELTA_TIME_MS) {
				toRemove.push(modelUrl);
			}
		}

		for (const e of toRemove) {
			this._stopModelSync(e);
		}
	}

	private _beginModelSync(resource: URI): void {
		let model = this._modelService.getModel(resource);
		if (!model) {
			return;
		}
		if (model.isTooLargeForSyncing()) {
			return;
		}

		let modelUrl = resource.toString();

		this._proxy.acceptNewModel({
			url: model.uri.toString(),
			lines: model.getLinesContent(),
			EOL: model.getEOL(),
			versionId: model.getVersionId()
		});

		const toDispose = new DisposableStore();
		toDispose.add(model.onDidChangeContent((e) => {
			this._proxy.acceptModelChanged(modelUrl.toString(), e);
		}));
		toDispose.add(model.onWillDispose(() => {
			this._stopModelSync(modelUrl);
		}));
		toDispose.add(toDisposable(() => {
			this._proxy.acceptRemovedModel(modelUrl);
		}));

		this._syncedModels[modelUrl] = toDispose;
	}

	private _stopModelSync(modelUrl: string): void {
		let toDispose = this._syncedModels[modelUrl];
		delete this._syncedModels[modelUrl];
		delete this._syncedModelsLastUsedTime[modelUrl];
		dispose(toDispose);
	}
}

export class LanguageDetectionWorkerHost {
	constructor(
		private _indexJsUri: string,
		private _modelJsonUri: string,
		private _weightsUri: string,
		private _telemetryService: ITelemetryService,
	) {
	}

	async getIndexJsUri() {
		return this._indexJsUri;
	}

	async getModelJsonUri() {
		return this._modelJsonUri;
	}

	async getWeightsUri() {
		return this._weightsUri;
	}

	async sendTelemetryEvent(languages: string[], confidences: number[], timeSpent: number): Promise<void> {
		type LanguageDetectionStats = { languages: string; confidences: string; timeSpent: number; };
		type LanguageDetectionStatsClassification = {
			languages: { classification: 'SystemMetaData', purpose: 'FeatureInsight' };
			confidences: { classification: 'SystemMetaData', purpose: 'FeatureInsight' };
			timeSpent: { classification: 'SystemMetaData', purpose: 'FeatureInsight' };
		};

		this._telemetryService.publicLog2<LanguageDetectionStats, LanguageDetectionStatsClassification>('automaticlanguagedetection.stats', {
			languages: languages.join(','),
			confidences: confidences.join(','),
			timeSpent
		});
	}
}

export class LanguageDetectionWorkerClient extends Disposable {
	private _worker: IWorkerClient<LanguageDetectionSimpleWorker> | null;
	private readonly _workerFactory: DefaultWorkerFactory;
	private _modelManager: LanguageDetectionModelManager | null;

	constructor(
		private readonly _modelService: IModelService,
		private readonly _telemetryService: ITelemetryService,
		label: string,
		public indexJsUri: string,
		public modelJsonUri: string,
		public weightsUri: string
	) {
		super();
		this._workerFactory = new DefaultWorkerFactory(label);
		this._worker = null;
		this._modelManager = null;

	}

	private _getOrCreateModelManager(proxy: LanguageDetectionSimpleWorker): LanguageDetectionModelManager {
		if (!this._modelManager) {
			this._modelManager = this._register(new LanguageDetectionModelManager(proxy, this._modelService, true));
		}
		return this._modelManager;
	}

	protected _withSyncedResources(resources: URI[]): Promise<LanguageDetectionSimpleWorker> {
		return this._getProxy().then((proxy) => {
			this._getOrCreateModelManager(proxy).ensureSyncedResources(resources);
			return proxy;
		});
	}

	private _getOrCreateWorker(): IWorkerClient<LanguageDetectionSimpleWorker> {
		if (!this._worker) {

			this._worker = this._register(new SimpleWorkerClient<LanguageDetectionSimpleWorker, LanguageDetectionWorkerHost>(
				this._workerFactory,
				'vs/workbench/services/languageDetection/browser/languageDetectionSimpleWorker',
				new LanguageDetectionWorkerHost(
					this.indexJsUri,
					this.modelJsonUri,
					this.weightsUri,
					this._telemetryService)
			));
		}
		return this._worker;
	}

	protected _getProxy(): Promise<LanguageDetectionSimpleWorker> {
		return this._getOrCreateWorker().getProxyObject();
	}

	public async detectLanguage(resource: URI): Promise<string | undefined> {
		const proxy = await this._withSyncedResources([resource]);
		return proxy.detectLanguage(resource.toString());
	}
	public async detectLanguages(resource: URI): Promise<string[]> {
		const proxy = await this._withSyncedResources([resource]);
		return proxy.detectLanguages(resource.toString());
	}
}

registerSingleton(ILanguageDetectionService, LanguageDetectionService);