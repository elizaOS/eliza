import crypto from "node:crypto";
import * as dns from "node:dns";
import fs from "node:fs";
import fsp from "node:fs/promises";
import * as http from "node:http";
import * as https from "node:https";
import os from "node:os";
import path from "node:path";
import {
	type ContentValue,
	logger,
	readJsonBody,
	sendJson,
	sendJsonError,
} from "@elizaos/core";
import {
	getMobileDeviceBridgeStatus,
	loadMobileDeviceBridgeModel,
	unloadMobileDeviceBridgeModel,
} from "@elizaos/plugin-capacitor-bridge";

type ModelRole = "chat" | "embedding" | "drafter";
type DownloadState =
	| "queued"
	| "downloading"
	| "completed"
	| "failed"
	| "cancelled";

export type LocalInferenceCommandIntent =
	| "retry"
	| "resume"
	| "redownload"
	| "download"
	| "cancel"
	| "switch_smaller"
	| "status"
	| "use_cloud"
	| "use_local";

interface CatalogModel {
	id: string;
	displayName: string;
	hfRepo: string;
	ggufFile: string;
	params: string;
	quant: string;
	sizeGb: number;
	minRamGb: number;
	category: string;
	bucket: string;
	blurb: string;
	role: ModelRole;
	companionModelIds?: string[];
	hiddenFromCatalog?: boolean;
}

interface InstalledModel {
	id: string;
	displayName: string;
	path: string;
	sizeBytes: number;
	hfRepo?: string;
	installedAt: string;
	lastUsedAt: string | null;
	source: "eliza-download";
	sha256?: string;
	lastVerifiedAt?: string;
}

interface DownloadJob {
	jobId: string;
	modelId: string;
	state: DownloadState;
	received: number;
	total: number;
	bytesPerSec: number;
	etaMs: number | null;
	startedAt: string;
	updatedAt: string;
	error?: string;
}

export interface LocalInferenceChatMetadata {
	[key: string]: ContentValue;
	intent?: LocalInferenceCommandIntent;
	status:
		| "missing"
		| "downloading"
		| "loading"
		| "failed"
		| "no_space"
		| "idle"
		| "ready"
		| "cancelled"
		| "routing";
	modelId?: string | null;
	activeModelId?: string | null;
	provider?: string;
	error?: string;
	progress?: {
		percent?: number;
		receivedBytes: number;
		totalBytes: number;
		bytesPerSec?: number;
		etaMs?: number | null;
	};
}

export interface LocalInferenceChatResult {
	text: string;
	localInference: LocalInferenceChatMetadata;
}

type Assignments = Partial<
	Record<"TEXT_SMALL" | "TEXT_LARGE" | "TEXT_EMBEDDING", string>
>;

interface RoutingPreferences {
	preferredProvider: Record<string, string>;
	policy: Record<string, string>;
}

interface RoutingPreferencesFile {
	version: number;
	preferences: RoutingPreferences;
}

let activeModelState: {
	modelId: string | null;
	loadedAt: string | null;
	status: "idle" | "loading" | "ready" | "error";
	error?: string;
} = { modelId: null, loadedAt: null, status: "idle" };

export function getLocalInferenceActiveModelId(): string | undefined {
	return activeModelState.status === "ready" && activeModelState.modelId?.trim()
		? activeModelState.modelId.trim()
		: undefined;
}

const CATALOG: CatalogModel[] = [
	{
		id: "eliza-1-mobile-1_7b",
		displayName: "Eliza-1 mobile 1.7B",
		hfRepo: "elizalabs/eliza-1-mobile-1_7b",
		ggufFile: "text/eliza-1-mobile-1_7b-32k.gguf",
		params: "1.7B",
		quant: "fused GGUF",
		sizeGb: 1.2,
		minRamGb: 4,
		category: "chat",
		bucket: "small",
		blurb: "Default local Eliza-1 chat model for mobile and laptops.",
		role: "chat",
	},
	{
		id: "eliza-1-desktop-9b",
		displayName: "Eliza-1 desktop 9B",
		hfRepo: "elizalabs/eliza-1-desktop-9b",
		ggufFile: "text/eliza-1-desktop-9b-64k.gguf",
		params: "9B",
		quant: "fused GGUF",
		sizeGb: 5.4,
		minRamGb: 16,
		category: "chat",
		bucket: "medium",
		blurb: "Higher-quality Eliza-1 local chat model for desktop systems.",
		role: "chat",
	},
	{
		id: "eliza-1-lite-0_6b",
		displayName: "Eliza-1 lite embeddings",
		hfRepo: "elizalabs/eliza-1-lite-0_6b",
		ggufFile: "text/eliza-1-lite-0_6b-32k.gguf",
		params: "0.6B",
		quant: "fused GGUF",
		sizeGb: 0.5,
		minRamGb: 1,
		category: "tiny",
		bucket: "small",
		blurb:
			"Default Eliza-1 local embedding model for memory and knowledge search.",
		role: "embedding",
	},
];

const activeDownloads = new Map<
	string,
	{ job: DownloadJob; abortController: AbortController }
>();
const MOBILE_DNS_SERVERS = ["8.8.8.8", "1.1.1.1"];
const mobileDnsResolver = new dns.Resolver();
mobileDnsResolver.setServers(MOBILE_DNS_SERVERS);

function stateDir(): string {
	return (
		process.env.ELIZA_STATE_DIR?.trim() || path.join(os.homedir(), ".eliza")
	);
}

function localInferenceRoot(): string {
	return path.join(stateDir(), "local-inference");
}

function modelsDir(): string {
	return path.join(localInferenceRoot(), "models");
}

function downloadsDir(): string {
	return path.join(localInferenceRoot(), "downloads");
}

function registryPath(): string {
	return path.join(localInferenceRoot(), "registry.json");
}

function assignmentsPath(): string {
	return path.join(localInferenceRoot(), "assignments.json");
}

function routingPath(): string {
	return path.join(localInferenceRoot(), "routing.json");
}

function finalModelPath(model: CatalogModel): string {
	return path.join(
		modelsDir(),
		`${model.id.replace(/[^a-zA-Z0-9._-]/g, "_")}.gguf`,
	);
}

function stagingPath(model: CatalogModel): string {
	return path.join(
		downloadsDir(),
		`${model.id.replace(/[^a-zA-Z0-9._-]/g, "_")}.part`,
	);
}

function huggingFaceResolveUrl(model: CatalogModel): string {
	const base =
		process.env.ELIZA_HF_BASE_URL?.trim().replace(/\/+$/, "") ||
		"https://huggingface.co";
	const encodedPath = model.ggufFile
		.split("/")
		.map((segment) => encodeURIComponent(segment))
		.join("/");
	return `${base}/${model.hfRepo}/resolve/main/${encodedPath}?download=true`;
}

function shouldUseMobileDns(): boolean {
	const platform = process.env.ELIZA_PLATFORM?.toLowerCase();
	return platform === "android" || platform === "ios";
}

const mobileLookup: http.RequestOptions["lookup"] = (
	hostname,
	options,
	callback,
) => {
	mobileDnsResolver.resolve4(hostname, (error, addresses) => {
		if (error) {
			callback(error, undefined as never, undefined as never);
			return;
		}
		if (options?.all) {
			callback(
				null,
				addresses.map((address) => ({ address, family: 4 })),
				undefined as never,
			);
			return;
		}
		callback(null, addresses[0], 4);
	});
};

async function openDownloadResponse(
	url: string,
	headers: Record<string, string>,
	signal: AbortSignal,
	redirectCount = 0,
): Promise<http.IncomingMessage> {
	if (redirectCount > 5) {
		throw new Error("Too many redirects while downloading model");
	}

	const parsed = new URL(url);
	const transport = parsed.protocol === "http:" ? http : https;

	return new Promise((resolve, reject) => {
		const req = transport.get(
			parsed,
			{
				headers,
				lookup: shouldUseMobileDns() ? mobileLookup : undefined,
			},
			(response) => {
				const statusCode = response.statusCode ?? 0;
				const location = response.headers.location;
				if (location && [301, 302, 303, 307, 308].includes(statusCode)) {
					response.resume();
					resolve(
						openDownloadResponse(
							new URL(location, parsed).toString(),
							headers,
							signal,
							redirectCount + 1,
						),
					);
					return;
				}
				resolve(response);
			},
		);

		const abort = () => {
			req.destroy(new Error("Download cancelled"));
		};
		if (signal.aborted) {
			abort();
			return;
		}
		signal.addEventListener("abort", abort, { once: true });
		req.on("error", reject);
		req.on("close", () => signal.removeEventListener("abort", abort));
	});
}

async function ensureLocalInferenceDirs(): Promise<void> {
	await fsp.mkdir(modelsDir(), { recursive: true });
	await fsp.mkdir(downloadsDir(), { recursive: true });
}

async function readJsonFile<T>(filePath: string, fallback: T): Promise<T> {
	try {
		return JSON.parse(await fsp.readFile(filePath, "utf8")) as T;
	} catch {
		return fallback;
	}
}

async function writeJsonFile(
	filePath: string,
	payload: unknown,
): Promise<void> {
	await fsp.mkdir(path.dirname(filePath), { recursive: true });
	const tmp = `${filePath}.tmp`;
	await fsp.writeFile(tmp, JSON.stringify(payload, null, 2), "utf8");
	await fsp.rename(tmp, filePath);
}

async function hashFile(filePath: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const hash = crypto.createHash("sha256");
		const stream = fs.createReadStream(filePath, {
			highWaterMark: 1024 * 1024,
		});
		stream.on("data", (chunk) => hash.update(chunk));
		stream.on("end", () => resolve(hash.digest("hex")));
		stream.on("error", reject);
	});
}

async function isGgufFile(filePath: string): Promise<boolean> {
	try {
		const file = await fsp.open(filePath, "r");
		try {
			const buffer = Buffer.alloc(4);
			await file.read(buffer, 0, 4, 0);
			return buffer.toString("ascii") === "GGUF";
		} finally {
			await file.close();
		}
	} catch {
		return false;
	}
}

async function readRegistry(): Promise<InstalledModel[]> {
	const registry = await readJsonFile<{
		version?: number;
		models?: InstalledModel[];
	}>(registryPath(), { version: 1, models: [] });
	const models = Array.isArray(registry.models) ? registry.models : [];
	const installed: InstalledModel[] = [];
	for (const model of models) {
		if (!model?.id || !model.path) continue;
		try {
			const stat = await fsp.stat(model.path);
			if (stat.isFile()) installed.push({ ...model, sizeBytes: stat.size });
		} catch {
			// Ignore stale registry entries.
		}
	}
	return installed;
}

async function writeRegistry(models: InstalledModel[]): Promise<void> {
	await writeJsonFile(registryPath(), { version: 1, models });
}

async function upsertInstalledModel(model: InstalledModel): Promise<void> {
	const current = await readRegistry();
	await writeRegistry([
		...current.filter((entry) => entry.id !== model.id),
		model,
	]);
}

async function removeInstalledModel(id: string): Promise<boolean> {
	const current = await readRegistry();
	const target = current.find((model) => model.id === id);
	if (!target) return false;
	await fsp.rm(target.path, { force: true });
	await writeRegistry(current.filter((model) => model.id !== id));
	return true;
}

async function readAssignments(): Promise<Assignments> {
	const file = await readJsonFile<{ assignments?: Assignments }>(
		assignmentsPath(),
		{
			assignments: {},
		},
	);
	return file.assignments ?? {};
}

async function writeAssignments(
	assignments: Assignments,
): Promise<Assignments> {
	await writeJsonFile(assignmentsPath(), { version: 1, assignments });
	return assignments;
}

function defaultRoutingPreferences(): RoutingPreferencesFile {
	return {
		version: 1,
		preferences: {
			preferredProvider: {},
			policy: {},
		},
	};
}

async function assignModel(
	model: CatalogModel,
	overwrite: boolean,
): Promise<void> {
	const assignments = await readAssignments();
	if (model.role === "embedding") {
		if (overwrite || !assignments.TEXT_EMBEDDING) {
			assignments.TEXT_EMBEDDING = model.id;
		}
	} else if (model.role === "chat") {
		if (overwrite || !assignments.TEXT_SMALL) assignments.TEXT_SMALL = model.id;
		if (overwrite || !assignments.TEXT_LARGE) assignments.TEXT_LARGE = model.id;
	}
	await writeAssignments(assignments);
}

async function ensureDefaultAssignment(model: CatalogModel): Promise<void> {
	await assignModel(model, false);
}

async function downloadModel(
	model: CatalogModel,
	record: DownloadJob,
): Promise<void> {
	const abortController = activeDownloads.get(model.id)?.abortController;
	if (!abortController) return;

	const finalPath = finalModelPath(model);
	const partialPath = stagingPath(model);
	const existingPartial = await fsp
		.stat(partialPath)
		.then((stat) => (stat.isFile() ? stat.size : 0))
		.catch(() => 0);

	record.state = "downloading";
	record.received = existingPartial;
	record.updatedAt = new Date().toISOString();

	try {
		const headers: Record<string, string> = {
			"user-agent": "Eliza-MobileLocalInference/1.0",
		};
		if (existingPartial > 0) headers.range = `bytes=${existingPartial}-`;
		const response = await openDownloadResponse(
			huggingFaceResolveUrl(model),
			headers,
			abortController.signal,
		);
		const statusCode = response.statusCode ?? 0;
		if (statusCode < 200 || statusCode >= 300) {
			throw new Error(`HTTP ${statusCode} ${response.statusMessage ?? ""}`);
		}
		const contentLength = Number.parseInt(
			String(response.headers["content-length"] ?? "0"),
			10,
		);
		if (Number.isFinite(contentLength) && contentLength > 0) {
			record.total = existingPartial + contentLength;
		}

		const stream = fs.createWriteStream(partialPath, {
			flags: existingPartial > 0 ? "a" : "w",
		});
		let lastSampleAt = Date.now();
		let lastSampleBytes = record.received;

		try {
			for await (const chunk of response) {
				const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
				if (!stream.write(Buffer.from(value))) {
					await new Promise<void>((resolve) => stream.once("drain", resolve));
				}
				record.received += value.length;
				const now = Date.now();
				const elapsed = now - lastSampleAt;
				if (elapsed >= 1000) {
					record.bytesPerSec =
						((record.received - lastSampleBytes) * 1000) / elapsed;
					record.etaMs =
						record.bytesPerSec > 0
							? ((record.total - record.received) * 1000) / record.bytesPerSec
							: null;
					lastSampleAt = now;
					lastSampleBytes = record.received;
					record.updatedAt = new Date().toISOString();
				}
			}
		} finally {
			stream.end();
			await new Promise<void>((resolve, reject) => {
				stream.on("finish", resolve);
				stream.on("error", reject);
			});
		}

		await fsp.rename(partialPath, finalPath);
		if (!(await isGgufFile(finalPath))) {
			throw new Error("Downloaded file is not a valid GGUF");
		}
		const stat = await fsp.stat(finalPath);
		const sha256 = await hashFile(finalPath);
		await upsertInstalledModel({
			id: model.id,
			displayName: model.displayName,
			path: finalPath,
			sizeBytes: stat.size,
			hfRepo: model.hfRepo,
			installedAt: new Date().toISOString(),
			lastUsedAt: null,
			source: "eliza-download",
			sha256,
			lastVerifiedAt: new Date().toISOString(),
		});
		await ensureDefaultAssignment(model);
		for (const companionId of model.companionModelIds ?? []) {
			if (!activeDownloads.has(companionId)) {
				void startDownload(companionId).catch((error) => {
					logger.warn(
						`[local-inference] Companion download failed for ${companionId}: ${
							error instanceof Error ? error.message : String(error)
						}`,
					);
				});
			}
		}

		record.state = "completed";
		record.received = stat.size;
		record.total = stat.size;
		record.updatedAt = new Date().toISOString();
	} catch (error) {
		if (abortController.signal.aborted) {
			record.state = "cancelled";
		} else {
			record.state = "failed";
			record.error = error instanceof Error ? error.message : String(error);
			logger.warn(
				`[local-inference] Download failed for ${model.id}: ${record.error}`,
			);
		}
		record.updatedAt = new Date().toISOString();
	} finally {
		if (record.state !== "downloading") {
			activeDownloads.delete(model.id);
		}
	}
}

async function startDownload(modelId: string): Promise<DownloadJob> {
	const existing = activeDownloads.get(modelId);
	if (existing) return { ...existing.job };
	const model = CATALOG.find((entry) => entry.id === modelId);
	if (!model) throw new Error(`Unknown model id: ${modelId}`);
	await ensureLocalInferenceDirs();
	const job: DownloadJob = {
		jobId: crypto.randomUUID(),
		modelId,
		state: "queued",
		received: 0,
		total: Math.round(model.sizeGb * 1024 ** 3),
		bytesPerSec: 0,
		etaMs: null,
		startedAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
	};
	activeDownloads.set(modelId, {
		job,
		abortController: new AbortController(),
	});
	void downloadModel(model, job);
	return { ...job };
}

async function installedSnapshot(): Promise<InstalledModel[]> {
	await ensureLocalInferenceDirs();
	return readRegistry();
}

export async function getLocalInferenceActiveSnapshot(): Promise<
	typeof activeModelState
> {
	const bridgeStatus = getMobileDeviceBridgeStatus();
	const loadedPath = bridgeStatus.devices.find((device) =>
		Boolean(device.loadedPath),
	)?.loadedPath;
	if (!loadedPath) return activeModelState;
	const installed = (await installedSnapshot()).find(
		(model) => model.path === loadedPath,
	);
	if (!installed) return activeModelState;
	const catalogModel = CATALOG.find((model) => model.id === installed.id);
	if (catalogModel?.role !== "chat") return activeModelState;
	return {
		modelId: installed.id,
		loadedAt: activeModelState.loadedAt,
		status: "ready",
	};
}

async function hubSnapshot(): Promise<Record<string, unknown>> {
	return {
		catalog: CATALOG.filter((model) => !model.hiddenFromCatalog),
		installed: await installedSnapshot(),
		active: await getLocalInferenceActiveSnapshot(),
		downloads: [...activeDownloads.values()].map(({ job }) => ({ ...job })),
		hardware: {
			totalRamGb: Math.round((os.totalmem() / 1024 ** 3) * 10) / 10,
			freeRamGb: Math.round((os.freemem() / 1024 ** 3) * 10) / 10,
			gpu: null,
			cpuCores: os.cpus().length,
			platform: process.platform,
			arch: process.arch,
			appleSilicon: process.platform === "darwin" && process.arch === "arm64",
			recommendedBucket: "small",
			source: "os-fallback",
		},
		assignments: await readAssignments(),
	};
}

function chatModels(): CatalogModel[] {
	return CATALOG.filter((model) => model.role === "chat");
}

function recommendedChatModel(): CatalogModel | null {
	const totalRamGb = os.totalmem() / 1024 ** 3;
	const candidates = chatModels()
		.filter((model) => totalRamGb >= model.minRamGb)
		.sort((left, right) => {
			const leftDflash = left.companionModelIds?.length ? 1 : 0;
			const rightDflash = right.companionModelIds?.length ? 1 : 0;
			if (leftDflash !== rightDflash && totalRamGb >= 6) {
				return rightDflash - leftDflash;
			}
			return right.sizeGb - left.sizeGb;
		});
	return (
		candidates[0] ?? chatModels().sort((a, b) => a.sizeGb - b.sizeGb)[0] ?? null
	);
}

function isNoSpaceMessage(value: unknown): boolean {
	const message =
		value instanceof Error
			? value.message
			: typeof value === "string"
				? value
				: "";
	return /\b(?:enospc|no space left|disk full|not enough (?:disk )?space|insufficient storage)\b/i.test(
		message,
	);
}

function formatBytes(bytes: number): string {
	if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
	const units = ["B", "KB", "MB", "GB", "TB"];
	let value = bytes;
	let unitIndex = 0;
	while (value >= 1024 && unitIndex < units.length - 1) {
		value /= 1024;
		unitIndex += 1;
	}
	const precision = value >= 10 || unitIndex === 0 ? 0 : 1;
	return `${value.toFixed(precision)} ${units[unitIndex]}`;
}

function progressForJob(
	job: DownloadJob,
): LocalInferenceChatMetadata["progress"] {
	const percent =
		job.total > 0
			? Math.max(0, Math.min(100, Math.round((job.received / job.total) * 100)))
			: undefined;
	return {
		...(typeof percent === "number" ? { percent } : {}),
		receivedBytes: job.received,
		totalBytes: job.total,
		...(job.bytesPerSec > 0
			? { bytesPerSec: Math.round(job.bytesPerSec) }
			: {}),
		etaMs: job.etaMs,
	};
}

function progressText(
	progress: LocalInferenceChatMetadata["progress"] | undefined,
): string {
	if (!progress) return "";
	const percent =
		typeof progress.percent === "number" ? `${progress.percent}%` : "progress";
	const total =
		progress.totalBytes > 0 ? ` of ${formatBytes(progress.totalBytes)}` : "";
	return `${percent} (${formatBytes(progress.receivedBytes)}${total})`;
}

function pickStatusLine(status: LocalInferenceChatMetadata["status"]): string {
	const variants: Record<LocalInferenceChatMetadata["status"], string[]> = {
		missing: [
			"I do not have a local chat model installed yet.",
			"Local chat is waiting on a model download.",
			"There is no local chat model ready on this device.",
		],
		downloading: [
			"The local model is still downloading.",
			"I am still pulling down the local model.",
			"Local inference is waiting for the model download to finish.",
		],
		loading: [
			"The local model is loading now.",
			"I am warming up the local model.",
			"Local inference is still bringing the model online.",
		],
		failed: [
			"The local model setup hit an error.",
			"Local inference failed before generation could start.",
			"The local model is not ready because the last operation failed.",
		],
		no_space: [
			"The local model needs more disk space before it can finish.",
			"Local inference is blocked because storage is full.",
			"The model download cannot continue until some disk space is freed.",
		],
		idle: [
			"A local model is installed, but none is loaded right now.",
			"Local inference is idle with an installed model available.",
			"The local model is installed and waiting to be activated.",
		],
		ready: [
			"Local inference is ready.",
			"The local model is loaded and ready.",
			"On-device inference is online.",
		],
		cancelled: [
			"I cancelled the local model download.",
			"The local download has been stopped.",
			"Local model download cancelled.",
		],
		routing: [
			"I updated the inference routing.",
			"The model routing preference is updated.",
			"Inference routing has been changed.",
		],
	};
	const list = variants[status];
	return list[Math.floor(Date.now() / 15_000) % list.length] ?? list[0];
}

function buildLocalInferenceChatResult(
	metadata: LocalInferenceChatMetadata,
	detail?: string,
): LocalInferenceChatResult {
	const progress = progressText(metadata.progress);
	const parts = [
		pickStatusLine(metadata.status),
		metadata.modelId ? `Model: ${metadata.modelId}.` : "",
		progress ? `Progress: ${progress}.` : "",
		metadata.error ? `Error: ${metadata.error}` : "",
		detail ?? "",
	].filter((part) => part.trim().length > 0);
	return {
		text: parts.join(" "),
		localInference: metadata,
	};
}

function resolveRequestedCatalogModel(prompt: string): CatalogModel | null {
	const normalized = prompt.toLowerCase();
	return (
		chatModels().find((model) => {
			const candidates = [
				model.id,
				model.displayName,
				model.params,
				model.bucket,
				model.category,
			].map((value) => value.toLowerCase());
			return candidates.some((candidate) => normalized.includes(candidate));
		}) ?? null
	);
}

async function resolveDefaultChatModel(
	prompt: string,
): Promise<CatalogModel | null> {
	const requested = resolveRequestedCatalogModel(prompt);
	if (requested) return requested;
	const installed = await installedSnapshot();
	const active = await getLocalInferenceActiveSnapshot();
	const activeCatalog = active.modelId
		? CATALOG.find(
				(model) => model.id === active.modelId && model.role === "chat",
			)
		: null;
	if (activeCatalog) return activeCatalog;
	const installedCatalog = installed
		.map((entry) =>
			CATALOG.find((model) => model.id === entry.id && model.role === "chat"),
		)
		.filter((model): model is CatalogModel => Boolean(model))
		.sort((a, b) => a.sizeGb - b.sizeGb)[0];
	return installedCatalog ?? recommendedChatModel();
}

async function setRoutingForChat(provider: string): Promise<void> {
	const current = await readJsonFile<RoutingPreferencesFile>(
		routingPath(),
		defaultRoutingPreferences(),
	);
	const preferences =
		current.preferences ?? defaultRoutingPreferences().preferences;
	for (const slot of ["TEXT_SMALL", "TEXT_LARGE"] as const) {
		preferences.preferredProvider[slot] = provider;
		preferences.policy[slot] = "manual";
	}
	await writeJsonFile(routingPath(), { version: 1, preferences });
}

async function activateInstalledModel(
	installed: InstalledModel,
): Promise<LocalInferenceChatResult> {
	activeModelState = {
		modelId: installed.id,
		loadedAt: null,
		status: "loading",
	};
	try {
		await loadMobileDeviceBridgeModel(installed.path, installed.id);
		activeModelState = {
			modelId: installed.id,
			loadedAt: new Date().toISOString(),
			status: "ready",
		};
		return buildLocalInferenceChatResult({
			intent: "use_local",
			status: "ready",
			modelId: installed.id,
			activeModelId: installed.id,
			provider: "capacitor-llama",
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		activeModelState = {
			modelId: installed.id,
			loadedAt: null,
			status: "error",
			error: message,
		};
		return buildLocalInferenceChatResult({
			intent: "use_local",
			status: isNoSpaceMessage(message) ? "no_space" : "failed",
			modelId: installed.id,
			activeModelId: null,
			error: message,
		});
	}
}

export async function getLocalInferenceChatStatus(
	intent: LocalInferenceCommandIntent = "status",
	error?: unknown,
): Promise<LocalInferenceChatResult> {
	const activeDownload = [...activeDownloads.values()]
		.map(({ job }) => ({ ...job }))
		.find((job) => job.state === "queued" || job.state === "downloading");
	if (activeDownload) {
		return buildLocalInferenceChatResult({
			intent,
			status: "downloading",
			modelId: activeDownload.modelId,
			activeModelId: activeModelState.modelId,
			progress: progressForJob(activeDownload),
		});
	}

	const active = await getLocalInferenceActiveSnapshot();
	if (activeModelState.status === "loading") {
		return buildLocalInferenceChatResult({
			intent,
			status: "loading",
			modelId: activeModelState.modelId,
			activeModelId: active.modelId,
		});
	}

	const errorMessage =
		error instanceof Error
			? error.message
			: typeof error === "string"
				? error
				: activeModelState.error;
	if (errorMessage) {
		return buildLocalInferenceChatResult({
			intent,
			status: isNoSpaceMessage(errorMessage) ? "no_space" : "failed",
			modelId: activeModelState.modelId,
			activeModelId: active.modelId,
			error: errorMessage,
		});
	}

	if (active.status === "ready" && active.modelId) {
		return buildLocalInferenceChatResult({
			intent,
			status: "ready",
			modelId: active.modelId,
			activeModelId: active.modelId,
			provider: "capacitor-llama",
		});
	}

	const installed = await installedSnapshot();
	const installedChat = installed.find((entry) =>
		CATALOG.some((model) => model.id === entry.id && model.role === "chat"),
	);
	if (installedChat) {
		return buildLocalInferenceChatResult({
			intent,
			status: "idle",
			modelId: installedChat.id,
			activeModelId: active.modelId,
		});
	}

	return buildLocalInferenceChatResult({
		intent,
		status: "missing",
		modelId: null,
		activeModelId: active.modelId,
	});
}

export async function handleLocalInferenceChatCommand(
	intent: LocalInferenceCommandIntent,
	prompt: string,
): Promise<LocalInferenceChatResult> {
	if (intent === "status") {
		return getLocalInferenceChatStatus(intent);
	}

	if (intent === "cancel") {
		const requested = resolveRequestedCatalogModel(prompt);
		const targets = requested ? [requested.id] : [...activeDownloads.keys()];
		for (const modelId of targets) {
			activeDownloads.get(modelId)?.abortController.abort();
			activeDownloads.delete(modelId);
		}
		return buildLocalInferenceChatResult({
			intent,
			status: "cancelled",
			modelId: requested?.id ?? targets[0] ?? null,
			activeModelId: activeModelState.modelId,
		});
	}

	if (intent === "use_cloud") {
		await setRoutingForChat("elizacloud");
		return buildLocalInferenceChatResult(
			{
				intent,
				status: "routing",
				modelId: activeModelState.modelId,
				activeModelId: activeModelState.modelId,
				provider: "elizacloud",
			},
			"Future chat model calls will prefer Eliza Cloud.",
		);
	}

	if (intent === "use_local") {
		await setRoutingForChat("capacitor-llama");
		const installed = await installedSnapshot();
		const requested = await resolveDefaultChatModel(prompt);
		const installedModel = installed.find(
			(entry) => entry.id === requested?.id,
		);
		if (installedModel) {
			return activateInstalledModel(installedModel);
		}
		if (requested) {
			const job = await startDownload(requested.id);
			return buildLocalInferenceChatResult(
				{
					intent: "download",
					status: "downloading",
					modelId: requested.id,
					activeModelId: activeModelState.modelId,
					provider: "capacitor-llama",
					progress: progressForJob(job),
				},
				"I also set chat routing to prefer local inference.",
			);
		}
		return getLocalInferenceChatStatus(intent);
	}

	if (intent === "switch_smaller") {
		const active = await getLocalInferenceActiveSnapshot();
		const installed = await installedSnapshot();
		const activeCatalog = active.modelId
			? CATALOG.find((model) => model.id === active.modelId)
			: null;
		const smallerInstalled = installed
			.map((entry) => ({
				entry,
				catalog: CATALOG.find(
					(model) => model.id === entry.id && model.role === "chat",
				),
			}))
			.filter(
				(entry): entry is { entry: InstalledModel; catalog: CatalogModel } => {
					const catalog = entry.catalog;
					if (!catalog) return false;
					return !activeCatalog || catalog.sizeGb < activeCatalog.sizeGb;
				},
			)
			.sort((a, b) => a.catalog.sizeGb - b.catalog.sizeGb)[0];
		if (smallerInstalled) {
			return activateInstalledModel(smallerInstalled.entry);
		}
		const smallest = chatModels().sort((a, b) => a.sizeGb - b.sizeGb)[0];
		if (smallest) {
			const job = await startDownload(smallest.id);
			return buildLocalInferenceChatResult(
				{
					intent,
					status: "downloading",
					modelId: smallest.id,
					activeModelId: active.modelId,
					progress: progressForJob(job),
				},
				"I could not switch to a smaller installed model, so I started the smallest local chat model download.",
			);
		}
	}

	const model = await resolveDefaultChatModel(prompt);
	if (!model) {
		return getLocalInferenceChatStatus(intent);
	}
	if (intent === "redownload") {
		await removeInstalledModel(model.id).catch(() => false);
	}
	const job = await startDownload(model.id);
	return buildLocalInferenceChatResult({
		intent,
		status: "downloading",
		modelId: model.id,
		activeModelId: activeModelState.modelId,
		progress: progressForJob(job),
	});
}

function writeSse(res: http.ServerResponse, payload: unknown): void {
	res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

export async function handleLocalInferenceRoutes(
	req: http.IncomingMessage,
	res: http.ServerResponse,
): Promise<boolean> {
	const method = (req.method ?? "GET").toUpperCase();
	const url = new URL(req.url ?? "/", "http://localhost");
	const pathname = url.pathname;
	if (!pathname.startsWith("/api/local-inference/")) return false;

	if (
		method === "GET" &&
		pathname === "/api/local-inference/downloads/stream"
	) {
		res.writeHead(200, {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache, no-transform",
			Connection: "keep-alive",
		});
		const interval = setInterval(() => {
			writeSse(res, {
				type: "snapshot",
				downloads: [...activeDownloads.values()].map(({ job }) => ({ ...job })),
			});
		}, 1000);
		interval.unref?.();
		writeSse(res, {
			type: "snapshot",
			downloads: [...activeDownloads.values()].map(({ job }) => ({ ...job })),
		});
		req.on("close", () => clearInterval(interval));
		return true;
	}

	if (method === "GET" && pathname === "/api/local-inference/hub") {
		sendJson(res, await hubSnapshot());
		return true;
	}
	if (method === "GET" && pathname === "/api/local-inference/hardware") {
		sendJson(res, (await hubSnapshot()).hardware);
		return true;
	}
	if (method === "GET" && pathname === "/api/local-inference/catalog") {
		sendJson(res, {
			models: CATALOG.filter((model) => !model.hiddenFromCatalog),
		});
		return true;
	}
	if (method === "GET" && pathname === "/api/local-inference/installed") {
		sendJson(res, { models: await installedSnapshot() });
		return true;
	}
	if (method === "GET" && pathname === "/api/local-inference/device") {
		sendJson(res, getMobileDeviceBridgeStatus());
		return true;
	}
	if (method === "GET" && pathname === "/api/local-inference/providers") {
		const bridge = getMobileDeviceBridgeStatus();
		const installed = await installedSnapshot();
		sendJson(res, {
			providers: [
				{
					id: "capacitor-llama",
					label: "On-device llama.cpp (mobile)",
					kind: "local",
					description:
						"Runs llama.cpp natively on iOS or Android via Capacitor.",
					supportedSlots: ["TEXT_SMALL", "TEXT_LARGE", "TEXT_EMBEDDING"],
					configureHref: null,
					enableState: {
						enabled: bridge.connected,
						reason: bridge.connected
							? "Device bridge connected"
							: "Waiting for device bridge",
					},
					registeredSlots: ["TEXT_SMALL", "TEXT_LARGE", "TEXT_EMBEDDING"],
				},
				{
					id: "eliza-local-inference",
					label: "Local models",
					kind: "local",
					description:
						"GGUF models installed in this mobile agent state directory.",
					supportedSlots: ["TEXT_SMALL", "TEXT_LARGE", "TEXT_EMBEDDING"],
					configureHref: "#local-inference-panel",
					enableState: {
						enabled: installed.length > 0,
						reason:
							installed.length > 0
								? "GGUF model installed"
								: "No local model installed",
					},
					registeredSlots: [],
				},
			],
		});
		return true;
	}
	if (method === "GET" && pathname === "/api/local-inference/assignments") {
		sendJson(res, { assignments: await readAssignments() });
		return true;
	}
	if (method === "POST" && pathname === "/api/local-inference/assignments") {
		const body = await readJsonBody<Record<string, unknown>>(req, res);
		if (!body) return true;
		const slot = typeof body.slot === "string" ? body.slot : null;
		if (!slot) {
			sendJsonError(res, "slot is required");
			return true;
		}
		const assignments = await readAssignments();
		if (typeof body.modelId === "string" && body.modelId.trim()) {
			assignments[slot as keyof Assignments] = body.modelId.trim();
		} else {
			delete assignments[slot as keyof Assignments];
		}
		sendJson(res, { assignments: await writeAssignments(assignments) });
		return true;
	}
	if (method === "GET" && pathname === "/api/local-inference/routing") {
		const preferences = await readJsonFile<RoutingPreferencesFile>(
			routingPath(),
			defaultRoutingPreferences(),
		);
		sendJson(res, {
			registrations: ["TEXT_SMALL", "TEXT_LARGE", "TEXT_EMBEDDING"].map(
				(modelType) => ({
					modelType,
					provider: "capacitor-llama",
					priority: 0,
					registeredAt: new Date().toISOString(),
				}),
			),
			preferences:
				preferences.preferences ?? defaultRoutingPreferences().preferences,
		});
		return true;
	}
	if (
		method === "POST" &&
		(pathname === "/api/local-inference/routing/preferred" ||
			pathname === "/api/local-inference/routing/policy")
	) {
		const body = await readJsonBody<Record<string, unknown>>(req, res);
		if (!body || typeof body.slot !== "string") {
			sendJsonError(res, "slot is required");
			return true;
		}
		const current = await readJsonFile<RoutingPreferencesFile>(
			routingPath(),
			defaultRoutingPreferences(),
		);
		const preferences =
			current.preferences ?? defaultRoutingPreferences().preferences;
		const slot = body.slot;
		if (pathname.endsWith("/preferred")) {
			if (typeof body.provider === "string" && body.provider.trim()) {
				preferences.preferredProvider[slot] = body.provider.trim();
			} else {
				delete preferences.preferredProvider[slot];
			}
		} else if (typeof body.policy === "string" && body.policy.trim()) {
			preferences.policy[slot] = body.policy.trim();
		} else {
			delete preferences.policy[slot];
		}
		await writeJsonFile(routingPath(), { version: 1, preferences });
		sendJson(res, { preferences });
		return true;
	}
	if (method === "POST" && pathname === "/api/local-inference/downloads") {
		const body = await readJsonBody<Record<string, unknown>>(req, res);
		if (!body) return true;
		const modelId = typeof body.modelId === "string" ? body.modelId : null;
		if (!modelId) {
			sendJsonError(res, "modelId is required");
			return true;
		}
		try {
			sendJson(res, { job: await startDownload(modelId) }, 202);
		} catch (error) {
			sendJsonError(
				res,
				error instanceof Error ? error.message : "Failed to start download",
				400,
			);
		}
		return true;
	}
	const downloadMatch = /^\/api\/local-inference\/downloads\/([^/]+)$/.exec(
		pathname,
	);
	if (method === "DELETE" && downloadMatch) {
		const modelId = decodeURIComponent(downloadMatch[1] ?? "");
		activeDownloads.get(modelId)?.abortController.abort();
		activeDownloads.delete(modelId);
		sendJson(res, { cancelled: true });
		return true;
	}
	if (method === "GET" && pathname === "/api/local-inference/active") {
		sendJson(res, await getLocalInferenceActiveSnapshot());
		return true;
	}
	if (method === "POST" && pathname === "/api/local-inference/active") {
		const body = await readJsonBody<Record<string, unknown>>(req, res);
		if (!body || typeof body.modelId !== "string") {
			sendJsonError(res, "modelId is required");
			return true;
		}
		const installed = (await installedSnapshot()).find(
			(model) => model.id === body.modelId,
		);
		if (!installed) {
			sendJsonError(res, `Model not installed: ${body.modelId}`, 404);
			return true;
		}
		const catalog = CATALOG.find((model) => model.id === installed.id);
		if (catalog) await assignModel(catalog, true);
		try {
			activeModelState = {
				modelId: installed.id,
				loadedAt: null,
				status: "loading",
			};
			await loadMobileDeviceBridgeModel(installed.path, installed.id);
			activeModelState = {
				modelId: installed.id,
				loadedAt: new Date().toISOString(),
				status: "ready",
			};
			sendJson(res, activeModelState);
		} catch (error) {
			activeModelState = {
				modelId: installed.id,
				loadedAt: null,
				status: "error",
				error: error instanceof Error ? error.message : String(error),
			};
			sendJsonError(
				res,
				error instanceof Error ? error.message : "Failed to load model",
				503,
			);
		}
		return true;
	}
	if (method === "DELETE" && pathname === "/api/local-inference/active") {
		try {
			await unloadMobileDeviceBridgeModel();
			activeModelState = { modelId: null, loadedAt: null, status: "idle" };
			sendJson(res, activeModelState);
		} catch (error) {
			sendJsonError(
				res,
				error instanceof Error ? error.message : "Failed to unload model",
				503,
			);
		}
		return true;
	}
	const verifyMatch =
		/^\/api\/local-inference\/installed\/([^/]+)\/verify$/.exec(pathname);
	if (method === "POST" && verifyMatch) {
		const id = decodeURIComponent(verifyMatch[1] ?? "");
		const installed = (await installedSnapshot()).find(
			(model) => model.id === id,
		);
		if (!installed) {
			sendJsonError(res, "Model not installed", 404);
			return true;
		}
		const currentSha256 = await hashFile(installed.path);
		sendJson(res, {
			state: currentSha256 === installed.sha256 ? "ok" : "unknown",
			currentSha256,
			expectedSha256: installed.sha256 ?? null,
			currentBytes: installed.sizeBytes,
		});
		return true;
	}
	const installedMatch = /^\/api\/local-inference\/installed\/([^/]+)$/.exec(
		pathname,
	);
	if (method === "DELETE" && installedMatch) {
		const id = decodeURIComponent(installedMatch[1] ?? "");
		sendJson(res, { removed: await removeInstalledModel(id) });
		return true;
	}
	if (method === "GET" && pathname === "/api/local-inference/hf-search") {
		sendJson(res, { models: [] });
		return true;
	}

	return false;
}
