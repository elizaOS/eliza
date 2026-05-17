import { serializeError, throwModelError } from "./errors.ts";
import {
	getEliza1BundleTiers,
	getEliza1Catalog,
	getEliza1VoiceComponents,
} from "./eliza1-catalog.ts";
import { HuggingFaceEliza1Client } from "./hf-eliza1-client.ts";
import { LocalInferenceApiClient } from "./local-inference-api-client.ts";
import {
	DownloadStateTracker,
	normalizeDownloadJob,
	normalizeDownloadJobs,
} from "./download-state.ts";
import type {
	Eliza1BundleTier,
	Eliza1VoiceComponent,
	LocalModelActiveSnapshot,
	LocalModelCatalogEntry,
	LocalModelDownloadJob,
	LocalModelEmbeddingParams,
	LocalModelEmbeddingResult,
	LocalModelGenerateParams,
	LocalModelGenerateResult,
	LocalModelHardwareSnapshot,
	LocalModelHubSnapshot,
	LocalModelInstalledEntry,
} from "./protocol.ts";

export class ModelSatelliteService {
	private readonly hfClient: HuggingFaceEliza1Client;
	private readonly downloadsTracker = new DownloadStateTracker();

	constructor(options: { hfClient?: HuggingFaceEliza1Client } = {}) {
		this.hfClient = options.hfClient ?? new HuggingFaceEliza1Client();
	}

	async status(params: { apiBase?: string } = {}): Promise<unknown> {
		const api = this.api(params.apiBase);
		try {
			return {
				ok: true,
				canonicalRepo: "elizaos/eliza-1",
				localInference: await api.status(),
			};
		} catch (error) {
			return {
				ok: false,
				canonicalRepo: "elizaos/eliza-1",
				error: serializeError(error),
			};
		}
	}

	async hub(params: { apiBase?: string } = {}): Promise<LocalModelHubSnapshot> {
		const api = this.api(params.apiBase);
		const [runtimeHub, routing] = await Promise.all([
			api.hub().catch((error) => ({ error: serializeError(error) })),
			api.routing().catch((error) => ({ error: serializeError(error) })),
		]);
		const installed = normalizeInstalledFromHub(runtimeHub);
		const active = normalizeActiveFromHub(runtimeHub);
		const downloads = this.downloadsTracker.merge(downloadsFromHub(runtimeHub));
		const catalog = mergeCatalog(getEliza1Catalog(), runtimeCatalog(runtimeHub), {
			installed,
			active,
		});
		return {
			catalog,
			eliza1Tiers: getEliza1BundleTiers(),
			voiceComponents: getEliza1VoiceComponents(),
			installed,
			active,
			downloads,
			hardware: normalizeHardwareFromHub(runtimeHub),
			assignments: normalizeAssignments(runtimeHub),
			routing,
			raw: {
				runtimeHub,
				hf: await this.hfMetadata(),
			},
		};
	}

	async catalog(params: { apiBase?: string } = {}): Promise<LocalModelCatalogEntry[]> {
		const api = this.api(params.apiBase);
		const runtime = await api.catalog().catch(() => null);
		const installed = await this.installed(params).catch(() => []);
		const active = await this.active(params).catch(() => ({
			modelId: null,
			status: "unknown" as const,
		}));
		return mergeCatalog(getEliza1Catalog(), runtimeCatalog(runtime), {
			installed,
			active,
		});
	}

	eliza1Catalog(): Promise<LocalModelCatalogEntry[]> {
		return Promise.resolve(getEliza1Catalog());
	}

	eliza1Tiers(): Promise<Eliza1BundleTier[]> {
		return Promise.resolve(getEliza1BundleTiers());
	}

	eliza1Voice(): Promise<Eliza1VoiceComponent[]> {
		return Promise.resolve(getEliza1VoiceComponents());
	}

	hfMetadata(): Promise<unknown> {
		return this.hfClient.metadata({
			force: process.env.ELIZA_PHASE8_HF_NETWORK === "1",
		});
	}

	async providers(params: { apiBase?: string } = {}): Promise<unknown[]> {
		const payload = await this.api(params.apiBase).providers();
		if (isRecord(payload) && Array.isArray(payload.providers)) return payload.providers;
		return [];
	}

	async hardware(
		params: { apiBase?: string } = {},
	): Promise<LocalModelHardwareSnapshot> {
		const payload = await this.api(params.apiBase).hardware();
		return normalizeHardware(payload);
	}

	async installed(
		params: { apiBase?: string } = {},
	): Promise<LocalModelInstalledEntry[]> {
		const payload = await this.api(params.apiBase).installed();
		return normalizeInstalled(payload);
	}

	async downloads(
		params: { apiBase?: string } = {},
	): Promise<LocalModelDownloadJob[]> {
		const payload = await this.api(params.apiBase).downloads();
		return this.downloadsTracker.merge(payload);
	}

	async startDownload(params: {
		apiBase?: string;
		modelId: string;
	}): Promise<LocalModelDownloadJob> {
		const payload = await this.api(params.apiBase).startDownload(params.modelId);
		const job = normalizeDownloadJob(
			isRecord(payload) && isRecord(payload.job) ? payload.job : payload,
		);
		this.downloadsTracker.upsert(job);
		return job;
	}

	async cancelDownload(params: {
		apiBase?: string;
		modelId: string;
	}): Promise<{ cancelled: boolean }> {
		const payload = await this.api(params.apiBase).cancelDownload(params.modelId);
		this.downloadsTracker.cancel(params.modelId);
		if (isRecord(payload) && typeof payload.cancelled === "boolean") {
			return { cancelled: payload.cancelled };
		}
		return { cancelled: true };
	}

	async active(
		params: { apiBase?: string } = {},
	): Promise<LocalModelActiveSnapshot> {
		const payload = await this.api(params.apiBase).active();
		return normalizeActive(payload);
	}

	async activate(params: {
		apiBase?: string;
		modelId: string;
	}): Promise<LocalModelActiveSnapshot> {
		const payload = await this.api(params.apiBase).activate(params.modelId);
		return normalizeActive(payload);
	}

	async unload(params: { apiBase?: string } = {}): Promise<LocalModelActiveSnapshot> {
		const payload = await this.api(params.apiBase).unload();
		return normalizeActive(payload);
	}

	async assignments(params: { apiBase?: string } = {}): Promise<Record<string, string>> {
		const payload = await this.api(params.apiBase).assignments();
		if (isRecord(payload) && isRecord(payload.assignments)) {
			return stringRecord(payload.assignments);
		}
		return {};
	}

	async setAssignment(params: {
		apiBase?: string;
		slot: string;
		modelId?: string | null;
	}): Promise<Record<string, string>> {
		const payload = await this.api(params.apiBase).setAssignment(params);
		if (isRecord(payload) && isRecord(payload.assignments)) {
			return stringRecord(payload.assignments);
		}
		return {};
	}

	routing(params: { apiBase?: string } = {}): Promise<unknown> {
		return this.api(params.apiBase).routing();
	}

	setRouting(params: {
		apiBase?: string;
		slot: string;
		provider?: string | null;
		policy?: string | null;
	}): Promise<unknown> {
		return this.api(params.apiBase).setRouting(params);
	}

	useLocal(params: { apiBase?: string } = {}): Promise<unknown> {
		return this.api(params.apiBase).useLocal();
	}

	useCloud(params: { apiBase?: string } = {}): Promise<unknown> {
		return this.api(params.apiBase).useCloud();
	}

	generate(
		params: LocalModelGenerateParams & { apiBase?: string },
	): Promise<LocalModelGenerateResult> {
		if (!params.prompt?.trim() && !params.messages?.length) {
			throwModelError({
				code: "MODEL_REQUEST_FAILED",
				message: "model.generate requires prompt or messages.",
			});
		}
		return this.api(params.apiBase).generate();
	}

	embedding(
		params: LocalModelEmbeddingParams & { apiBase?: string },
	): Promise<LocalModelEmbeddingResult> {
		if (!params.input?.trim()) {
			throwModelError({
				code: "MODEL_REQUEST_FAILED",
				message: "model.embedding requires input.",
			});
		}
		return this.api(params.apiBase).embedding();
	}

	capabilities(params: { apiBase?: string } = {}): Promise<unknown> {
		return this.api(params.apiBase).capabilities();
	}

	private api(apiBase?: string): LocalInferenceApiClient {
		return new LocalInferenceApiClient({ apiBase });
	}
}

function mergeCatalog(
	local: LocalModelCatalogEntry[],
	runtime: LocalModelCatalogEntry[],
	status: {
		installed: LocalModelInstalledEntry[];
		active: LocalModelActiveSnapshot;
	},
): LocalModelCatalogEntry[] {
	const installedIds = new Set(status.installed.map((entry) => entry.id));
	const byId = new Map<string, LocalModelCatalogEntry>();
	for (const entry of [...local, ...runtime]) byId.set(entry.id, entry);
	return [...byId.values()].map((entry) => ({
		...entry,
		installed: installedIds.has(entry.id),
		active: status.active.modelId === entry.id,
	}));
}

function runtimeCatalog(payload: unknown): LocalModelCatalogEntry[] {
	const rawModels = isRecord(payload) && Array.isArray(payload.models)
		? payload.models
		: isRecord(payload) && Array.isArray(payload.catalog)
			? payload.catalog
			: [];
	return rawModels.map((model) => normalizeRuntimeCatalogEntry(model));
}

function normalizeRuntimeCatalogEntry(value: unknown): LocalModelCatalogEntry {
	if (!isRecord(value)) {
		return {
			id: "unknown",
			displayName: "Unknown local model",
			provider: "eliza-local-inference",
			family: "eliza-1",
			hfRepo: "elizaos/eliza-1",
			roles: ["chat"],
			capabilities: ["text-generation"],
			raw: value,
		};
	}
	const id = stringField(value, "id") ?? "unknown";
	const category = stringField(value, "category");
	const roles = category === "drafter" ? ["drafter" as const] : ["chat" as const];
	const capabilities = category === "drafter"
		? ["dflash" as const]
		: ["text-generation" as const];
	return {
		id,
		displayName: stringField(value, "displayName") ?? id,
		provider: "eliza-local-inference",
		family: "eliza-1",
		hfRepo: stringField(value, "hfRepo") ?? "elizaos/eliza-1",
		bundlePath: stringField(value, "hfPathPrefix"),
		tier: id.replace(/^eliza-1-/, ""),
		params: stringField(value, "params"),
		sizeGb: numberField(value, "sizeGb"),
		minRamGb: numberField(value, "minRamGb"),
		contextLength: numberField(value, "contextLength"),
		quantization: stringField(value, "quant") ?? "Q4_K_M",
		roles,
		capabilities,
		raw: value,
	};
}

function normalizeInstalledFromHub(payload: unknown): LocalModelInstalledEntry[] {
	if (isRecord(payload) && Array.isArray(payload.installed)) {
		return normalizeInstalled(payload.installed);
	}
	return [];
}

function normalizeInstalled(payload: unknown): LocalModelInstalledEntry[] {
	const models = Array.isArray(payload)
		? payload
		: isRecord(payload) && Array.isArray(payload.models)
			? payload.models
			: [];
	return models.map((entry) => normalizeInstalledEntry(entry));
}

function normalizeInstalledEntry(value: unknown): LocalModelInstalledEntry {
	if (!isRecord(value)) {
		return {
			id: "unknown",
			path: "",
			raw: value,
		};
	}
	return {
		id: stringField(value, "id") ?? "unknown",
		displayName: stringField(value, "displayName"),
		path: stringField(value, "path") ?? "",
		sizeBytes: numberField(value, "sizeBytes"),
		hfRepo: stringField(value, "hfRepo"),
		bundlePath: stringField(value, "bundleRoot"),
		installedAt: stringField(value, "installedAt"),
		lastUsedAt:
			typeof value.lastUsedAt === "string" || value.lastUsedAt === null
				? value.lastUsedAt
				: undefined,
		sha256: stringField(value, "sha256"),
		lastVerifiedAt: stringField(value, "lastVerifiedAt"),
		raw: value,
	};
}

function normalizeActiveFromHub(payload: unknown): LocalModelActiveSnapshot {
	if (isRecord(payload) && isRecord(payload.active)) return normalizeActive(payload.active);
	return { modelId: null, status: "unknown" };
}

function normalizeActive(payload: unknown): LocalModelActiveSnapshot {
	if (!isRecord(payload)) return { modelId: null, status: "unknown", raw: payload };
	const statusValue = stringField(payload, "status");
	const status =
		statusValue === "idle" ||
		statusValue === "loading" ||
		statusValue === "ready" ||
		statusValue === "error"
			? statusValue
			: "unknown";
	return {
		modelId: stringField(payload, "modelId") ?? null,
		loadedAt:
			typeof payload.loadedAt === "string" || payload.loadedAt === null
				? payload.loadedAt
				: undefined,
		status,
		provider: stringField(payload, "provider"),
		error: stringField(payload, "error"),
		raw: payload,
	};
}

function normalizeHardwareFromHub(
	payload: unknown,
): LocalModelHardwareSnapshot | undefined {
	if (isRecord(payload) && isRecord(payload.hardware)) {
		return normalizeHardware(payload.hardware);
	}
	return undefined;
}

function normalizeHardware(payload: unknown): LocalModelHardwareSnapshot {
	if (!isRecord(payload)) return { raw: payload };
	return {
		totalRamGb: numberField(payload, "totalRamGb"),
		freeRamGb: numberField(payload, "freeRamGb"),
		gpu: payload.gpu,
		cpuCores: numberField(payload, "cpuCores"),
		platform: stringField(payload, "platform"),
		arch: stringField(payload, "arch"),
		appleSilicon:
			typeof payload.appleSilicon === "boolean" ? payload.appleSilicon : undefined,
		recommendedTier:
			stringField(payload, "recommendedTier") ??
			stringField(payload, "recommendedBucket"),
		source: stringField(payload, "source"),
		raw: payload,
	};
}

function downloadsFromHub(payload: unknown): LocalModelDownloadJob[] {
	if (isRecord(payload) && Array.isArray(payload.downloads)) {
		return normalizeDownloadJobs(payload.downloads);
	}
	return [];
}

function normalizeAssignments(payload: unknown): Record<string, string> | undefined {
	if (isRecord(payload) && isRecord(payload.assignments)) {
		return stringRecord(payload.assignments);
	}
	return undefined;
}

function stringRecord(value: Record<string, unknown>): Record<string, string> {
	const output: Record<string, string> = {};
	for (const [key, field] of Object.entries(value)) {
		if (typeof field === "string") output[key] = field;
	}
	return output;
}

function stringField(
	value: Record<string, unknown>,
	key: string,
): string | undefined {
	const field = value[key];
	return typeof field === "string" && field.length > 0 ? field : undefined;
}

function numberField(
	value: Record<string, unknown>,
	key: string,
): number | undefined {
	const field = value[key];
	return typeof field === "number" && Number.isFinite(field) ? field : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
