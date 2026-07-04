/**
 * Resumable GGUF downloader.
 *
 * Streams directly from HuggingFace to a staging file under
 * `$STATE_DIR/local-inference/downloads/<id>.part`, then atomically moves
 * it into `models/<id>.gguf` on success. On restart the staging file is
 * still there; `resumeIfPossible` sends a Range request starting at the
 * current partial size.
 *
 * Concurrency model: at most one download per model id. Callers use
 * `subscribe()` to receive progress events; the service facade wires that
 * to SSE.
 *
 * The runtime `fetch` follows HuggingFace redirects and still gives us a body
 * stream that can be piped into a Node WriteStream.
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { Readable, type Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { logger } from "@elizaos/core";
import { ensureDefaultAssignment } from "./assignments";
import {
	buildHuggingFaceResolveUrlCandidatesForPath,
	findCatalogModel,
	type HfResolveUrlCandidate,
	isDefaultEligibleId,
} from "./catalog";
import { deviceCapsFromProbe, probeHardware } from "./hardware";
import {
	libStagedName,
	resolveHostLibTargets,
	selectBundleLibFiles,
} from "./lib-target";
import {
	type Eliza1DeviceCaps,
	type Eliza1FileEntry,
	type Eliza1Files,
	type Eliza1Manifest,
	parseManifestOrThrow,
	SUPPORTED_BACKENDS_BY_TIER,
} from "./manifest";
import {
	downloadsStagingDir,
	elizaModelsDir,
	localInferenceRoot,
} from "./paths";
import { upsertElizaModel } from "./registry";
import {
	type CatalogModel,
	classifyCatalogModelRuntimeClass,
	type DownloadEvent,
	type DownloadJob,
	type DownloadState,
	type HardwareProbe,
	type InstalledModel,
} from "./types";
import { hashFile } from "./verify";

interface ActiveJob {
	job: DownloadJob;
	abortController: AbortController;
	stagingPath: string;
	finalPath: string;
}

type DownloadListener = (event: DownloadEvent) => void;
type BundleFileKind = keyof Eliza1Files;
const HUB_FAILOVER_BASE_BACKOFF_MS = 25;
const HUB_ERROR_BODY_LIMIT_BYTES = 64 * 1024;

/**
 * Thrown before any weight byte is fetched when an Eliza-1 bundle's manifest
 * is incompatible with this device — wrong schema version, no overlapping
 * verified backend, or a RAM budget that exceeds the device's memory. Per
 * `packages/inference/AGENTS.md` §7 there is no "download anyway" path.
 */
export class BundleIncompatibleError extends Error {
	readonly code = "ELIZA1_BUNDLE_INCOMPATIBLE" as const;
	constructor(message: string) {
		super(message);
		this.name = "BundleIncompatibleError";
	}
}

/**
 * Thrown when HuggingFace answers a download with 401/403 — the repo is gated or
 * private and this device cannot see it with the credentials it has. Distinct
 * from a generic `HTTP <status>` failure so the UI can present one consistent
 * "link this device to Eliza Cloud" recovery keyed off real HTTP evidence,
 * rather than content-sniffing an HTML login body.
 */
export class GatedRepoError extends Error {
	readonly code = "HF_GATED_REPO" as const;
	readonly httpStatus: number;
	constructor(message: string, httpStatus: number) {
		super(message);
		this.name = "GatedRepoError";
		this.httpStatus = httpStatus;
	}
}

/**
 * Transient HTTP statuses worth retrying with backoff: 429 rate-limit and 5xx.
 * A 429 is NOT a 404 — the artifact exists, HuggingFace is throttling. Ported
 * from `lifecycle-remote-checks.ts`.
 */
function isTransientStatus(statusCode: number): boolean {
	return statusCode === 429 || statusCode >= 500;
}

/** Honor a `Retry-After` header (seconds), bounded so a hostile header can't stall a download. */
function retryAfterMs(
	headers: Record<string, string | string[] | undefined>,
): number | null {
	const raw = headers["retry-after"];
	const value = Array.isArray(raw) ? raw[0] : raw;
	if (!value) return null;
	const seconds = Number(value);
	if (!Number.isFinite(seconds) || seconds < 0) return null;
	return Math.min(seconds * 1000, DOWNLOAD_MAX_RETRY_AFTER_MS);
}

const DOWNLOAD_TRANSIENT_ATTEMPTS = 3;
const DOWNLOAD_TRANSIENT_BACKOFF_MS = 1_000;
const DOWNLOAD_MAX_RETRY_AFTER_MS = 10_000;

/**
 * One-time verify-on-device pass per `packages/inference/AGENTS.md` §7:
 * load → 1-token text generation → 1-phrase voice generation → barge-in
 * cancel. The downloader stays decoupled from the engine — the service
 * layer injects this; when absent the bundle is materialized and registered
 * but its `bundleVerifiedAt` stays unset and it does NOT auto-fill an empty
 * default slot (an unverified bundle must not become the recommended
 * default).
 */
export type VerifyBundleOnDevice = (args: {
	modelId: string;
	bundleRoot: string;
	manifestPath: string;
	textGgufPath: string;
}) => Promise<void>;

export interface DownloaderOptions {
	/** Override the device-capability probe (tests / headless environments). */
	probeDeviceCaps?: () => Promise<Eliza1DeviceCaps>;
	/** Verify-on-device smoke run; see {@link VerifyBundleOnDevice}. */
	verifyOnDevice?: VerifyBundleOnDevice;
	/** Override the hardware probe used by the disk-space preflight (tests). */
	probeHardware?: () => Promise<HardwareProbe>;
	/** Injectable sleep for transient-retry backoff (tests). Defaults to setTimeout. */
	sleep?: (ms: number) => Promise<void>;
}

function defaultDownloadSleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function defaultProbeDeviceCaps(): Promise<Eliza1DeviceCaps> {
	return deviceCapsFromProbe(await probeHardware());
}

/**
 * Reject bundles this device cannot run — runs against the manifest before
 * any weight byte is fetched. Mirrors the publish-side `canSetAsDefault`
 * device check, minus the `defaultEligible` flag (a user may explicitly
 * install a non-default bundle, but only one the device can actually load).
 */
function assertBundleInstallable(
	manifest: Eliza1Manifest,
	device: Eliza1DeviceCaps,
): void {
	// Schema version is enforced upstream by `parseManifestOrThrow` — the Zod
	// schema only accepts the current `$schema` URL, so a manifest with a
	// non-current schema version is rejected before we get here.
	if (manifest.ramBudgetMb.min > device.ramMb) {
		throw new BundleIncompatibleError(
			`Eliza-1 bundle ${manifest.id} needs at least ${manifest.ramBudgetMb.min} MB RAM; this device has ${device.ramMb} MB`,
		);
	}
	const tierBackends = new Set(SUPPORTED_BACKENDS_BY_TIER[manifest.tier]);
	const usable = device.availableBackends.filter(
		(b) =>
			tierBackends.has(b) &&
			manifest.kernels.verifiedBackends[b].status === "pass",
	);
	if (usable.length === 0) {
		const verified = Object.entries(manifest.kernels.verifiedBackends)
			.filter(([, v]) => v.status === "pass")
			.map(([b]) => b);
		throw new BundleIncompatibleError(
			`Eliza-1 bundle ${manifest.id}: no required-kernel backend is available on this device. ` +
				`bundle verified [${verified.join(", ") || "none"}], device has [${device.availableBackends.join(", ")}], tier ${manifest.tier} supports [${[...tierBackends].join(", ")}]`,
		);
	}
}

interface DownloadedFile {
	path: string;
	sizeBytes: number;
	sha256: string;
}

const PROGRESS_THROTTLE_MS = 250;
const TERMINAL_DOWNLOADS_FILENAME = "download-status.json";
const TERMINAL_DOWNLOAD_LIMIT = 32;
/** Headroom kept free above the download size for the disk-space preflight. */
const DISK_HEADROOM_GB = 0.5;
/**
 * Attempts per sha256-verified bundle file. The hub re-publishes files under
 * stable names (a tier's weights can move to a new base model), so a mismatch
 * after a completed transfer can be a transient race (stale CDN edge, content
 * changed mid-download) — one clean re-fetch from byte 0 resolves those; a
 * second mismatch means the manifest and the published bytes genuinely
 * disagree and the job fails.
 */
const SHA_MISMATCH_MAX_ATTEMPTS = 2;

/** Poll interval while a native background download is in flight (#11841). */
const BACKGROUND_DOWNLOAD_POLL_MS = 500;

/**
 * Native iOS background-`URLSession` download bridge, exposed by the full-Bun /
 * JSContext runtime on `globalThis.__ELIZA_BRIDGE__` (#11841). Present only on
 * iOS; absent (so the in-process fetch path is used) on desktop, Android, and
 * in tests unless a fake is installed. Each function resolves the native
 * host-call `result` object.
 */
interface NativeBackgroundDownloadBridge {
	bg_download_start(args: {
		id: string;
		url: string;
		headers: Record<string, string>;
		destPath: string;
		expectedTotalBytes: number;
	}): unknown | Promise<unknown>;
	bg_download_status(args: { id: string }): unknown | Promise<unknown>;
	bg_download_cancel(args: { id: string }): unknown | Promise<unknown>;
}

interface NativeBackgroundDownloadStatus {
	state: "running" | "completed" | "failed" | "cancelled";
	received?: number;
	total?: number;
	destPath?: string;
	error?: string;
}

function parseBackgroundStatus(raw: unknown): NativeBackgroundDownloadStatus {
	const value =
		raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
	const state =
		value.state === "completed" ||
		value.state === "failed" ||
		value.state === "cancelled"
			? value.state
			: "running";
	return {
		state,
		received: typeof value.received === "number" ? value.received : undefined,
		total: typeof value.total === "number" ? value.total : undefined,
		destPath: typeof value.destPath === "string" ? value.destPath : undefined,
		error: typeof value.error === "string" ? value.error : undefined,
	};
}

function makeAbortError(): Error {
	const error = new Error("Download aborted");
	error.name = "AbortError";
	return error;
}

interface TerminalDownloadsFile {
	version: 1;
	jobs: DownloadJob[];
}

async function* readFetchBody(
	body: ReadableStream<Uint8Array>,
): AsyncIterable<Buffer> {
	const reader = body.getReader();
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) return;
			if (value) yield Buffer.from(value);
		}
	} finally {
		reader.releaseLock();
	}
}

function stagingFilename(modelId: string): string {
	// Filename is derived deterministically so repeated download attempts
	// reuse the same partial file and actually resume.
	const safe = modelId.replace(/[^a-zA-Z0-9._-]/g, "_");
	return `${safe}.part`;
}

function finalFilename(model: CatalogModel): string {
	const safe = model.id.replace(/[^a-zA-Z0-9._-]/g, "_");
	return `${safe}.gguf`;
}

/**
 * GGUF files begin with the ASCII magic `GGUF`. A non-GGUF body (e.g. an HTML
 * auth/redirect page returned with HTTP 200 by a gated repo) must never be
 * registered as an installed model.
 */
async function hasGgufMagic(filePath: string): Promise<boolean> {
	try {
		const handle = await fsp.open(filePath, "r");
		try {
			const buffer = Buffer.alloc(4);
			await handle.read(buffer, 0, 4, 0);
			return buffer.toString("ascii") === "GGUF";
		} finally {
			await handle.close();
		}
	} catch {
		return false;
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function failoverBackoffMs(attemptIndex: number): number {
	return HUB_FAILOVER_BASE_BACKOFF_MS * 2 ** attemptIndex;
}

function isTransientHubStatus(statusCode: number): boolean {
	return statusCode >= 500;
}

async function readHubErrorBody(body: AsyncIterable<Buffer>): Promise<string> {
	const chunks: Buffer[] = [];
	let total = 0;
	for await (const chunk of body) {
		const remaining = HUB_ERROR_BODY_LIMIT_BYTES - total;
		if (remaining <= 0) break;
		const slice =
			chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
		chunks.push(slice);
		total += slice.length;
		if (total >= HUB_ERROR_BODY_LIMIT_BYTES) break;
	}
	return Buffer.concat(chunks).toString("utf8");
}

function parseGatedHubError(body: string): { repo: string } | null {
	try {
		const parsed = JSON.parse(body) as { code?: unknown; repo?: unknown };
		if (parsed.code === "HF_GATED" && typeof parsed.repo === "string") {
			return { repo: parsed.repo };
		}
		return null;
	} catch {
		return null;
	}
}

function gatedRepoMessage(repo: string, httpStatus: number): string {
	return (
		`HuggingFace repo ${repo} is gated or private (HTTP ${httpStatus}). ` +
		"Link or authorize this device with Eliza Cloud, then retry — gated downloads route " +
		"through the cloud HuggingFace proxy."
	);
}

function bundleDirname(modelId: string): string {
	const safe = modelId.replace(/[^a-zA-Z0-9._-]/g, "_");
	return `${safe}.bundle`;
}

function bundleStagingFilename(modelId: string, filePath: string): string {
	const safePath = filePath.replace(/[^a-zA-Z0-9._-]/g, "_");
	return stagingFilename(`${modelId}__${safePath}`);
}

export function bundleTargetPath(root: string, filePath: string): string {
	if (
		!filePath ||
		path.isAbsolute(filePath) ||
		/^[a-zA-Z]:[\\/]/.test(filePath)
	) {
		throw new Error(`Invalid bundle file path: ${filePath}`);
	}
	const resolvedRoot = path.resolve(root);
	const target = path.resolve(resolvedRoot, filePath);
	if (
		target !== resolvedRoot &&
		!target.startsWith(`${resolvedRoot}${path.sep}`)
	) {
		throw new Error(`Bundle file escapes install root: ${filePath}`);
	}
	return target;
}

export function parseBundleManifestOrThrow(
	input: unknown,
	catalogEntry: CatalogModel,
): Eliza1Manifest {
	const manifest = parseManifestOrThrow(input);
	if (manifest.id !== catalogEntry.id) {
		throw new Error(
			`Invalid Eliza-1 manifest: id ${manifest.id} does not match ${catalogEntry.id}`,
		);
	}
	if (
		!manifest.files.text.some((entry) => entry.path === catalogEntry.ggufFile)
	) {
		throw new Error(
			`Invalid Eliza-1 manifest: primary text file ${catalogEntry.ggufFile} is missing`,
		);
	}

	return manifest;
}

export function collectBundleFiles(
	manifest: Eliza1Manifest,
): Array<{ kind: BundleFileKind; entry: Eliza1FileEntry }> {
	const seen = new Map<
		string,
		{ kind: BundleFileKind; entry: Eliza1FileEntry }
	>();
	for (const kind of [
		"text",
		"voice",
		"asr",
		"vision",
		"mtp",
		"cache",
		"embedding",
		"vad",
		"wakeword",
	] as const) {
		for (const entry of manifest.files[kind] ?? []) {
			const current = seen.get(entry.path);
			if (current && current.entry.sha256 !== entry.sha256) {
				throw new Error(
					`Conflicting sha256 entries for bundle file ${entry.path}`,
				);
			}
			seen.set(entry.path, { kind, entry });
		}
	}
	return [...seen.values()];
}

async function ensureDirs(): Promise<void> {
	await fsp.mkdir(downloadsStagingDir(), { recursive: true });
	await fsp.mkdir(elizaModelsDir(), { recursive: true });
}

function terminalDownloadsPath(): string {
	return path.join(localInferenceRoot(), TERMINAL_DOWNLOADS_FILENAME);
}

async function partialSize(stagingPath: string): Promise<number> {
	try {
		const stat = await fsp.stat(stagingPath);
		return stat.isFile() ? stat.size : 0;
	} catch {
		return 0;
	}
}

/** Sidecar recording which expected sha256 a `.part` file was started against. */
function stagingMetaPath(stagingPath: string): string {
	return `${stagingPath}.expected`;
}

/**
 * A `.part` file is resumable only when it was started against the SAME
 * content hash the current manifest declares for the file. HuggingFace
 * re-publishes bundle files under stable names (e.g. `eliza-1-2b-128k.gguf`
 * moving from qwen35 to gemma4 weights), so a partial from a previous
 * manifest version must be discarded — a Range resume would append
 * new-version bytes onto old-version bytes and produce a corrupt blob that
 * only fails at the final sha256 gate, gigabytes later. A partial with no
 * sidecar has unknown provenance and is discarded too.
 */
async function resumableStartByte(
	stagingPath: string,
	expectedSha256: string,
): Promise<number> {
	const size = await partialSize(stagingPath);
	if (size <= 0) {
		await fsp
			.rm(stagingMetaPath(stagingPath), { force: true })
			.catch(() => undefined);
		return 0;
	}
	let recorded: string | undefined;
	try {
		recorded = (
			await fsp.readFile(stagingMetaPath(stagingPath), "utf8")
		).trim();
	} catch {
		recorded = undefined;
	}
	if (recorded === expectedSha256) return size;
	logger.warn(
		`[Downloader] discarding stale partial ${path.basename(stagingPath)} ` +
			`(started against ${recorded ? `sha256 ${recorded.slice(0, 12)}…` : "unknown content"}, ` +
			`manifest now expects ${expectedSha256.slice(0, 12)}…)`,
	);
	await fsp.rm(stagingPath, { force: true }).catch(() => undefined);
	await fsp
		.rm(stagingMetaPath(stagingPath), { force: true })
		.catch(() => undefined);
	return 0;
}

export class Downloader {
	private readonly active = new Map<string, ActiveJob>();
	private readonly terminal = new Map<string, DownloadJob>();
	private readonly listeners = new Set<DownloadListener>();
	private readonly lastEmit = new Map<string, number>();
	private readonly probeDeviceCaps: () => Promise<Eliza1DeviceCaps>;
	private readonly verifyOnDevice?: VerifyBundleOnDevice;
	private readonly probeHardware: () => Promise<HardwareProbe>;
	private readonly sleep: (ms: number) => Promise<void>;

	constructor(options: DownloaderOptions = {}) {
		this.probeDeviceCaps = options.probeDeviceCaps ?? defaultProbeDeviceCaps;
		this.verifyOnDevice = options.verifyOnDevice;
		this.probeHardware = options.probeHardware ?? probeHardware;
		this.sleep = options.sleep ?? defaultDownloadSleep;
		this.loadTerminalDownloads();
	}

	subscribe(listener: DownloadListener): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	snapshot(): DownloadJob[] {
		const active = [...this.active.values()].map((a) => ({ ...a.job }));
		const activeIds = new Set(active.map((job) => job.modelId));
		const terminal = [...this.terminal.values()]
			.filter((job) => !activeIds.has(job.modelId))
			.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
			.map((job) => ({ ...job }));
		return [...active, ...terminal];
	}

	isActive(modelId: string): boolean {
		const current = this.active.get(modelId);
		return (
			!!current &&
			(current.job.state === "queued" || current.job.state === "downloading")
		);
	}

	/**
	 * Start a download for a curated Eliza-1 catalog entry. Object specs are
	 * accepted only for internal tests that decorate a known Eliza-1 id; ad-hoc
	 * Hugging Face / ModelScope specs are rejected before any reservation or
	 * network I/O.
	 */
	async start(modelIdOrSpec: string | CatalogModel): Promise<DownloadJob> {
		const catalogEntry =
			typeof modelIdOrSpec === "string"
				? findCatalogModel(modelIdOrSpec)
				: modelIdOrSpec;
		if (!catalogEntry) {
			throw new Error(
				`Unknown model id: ${typeof modelIdOrSpec === "string" ? modelIdOrSpec : "(no id)"}`,
			);
		}
		const curated = findCatalogModel(catalogEntry.id);
		if (!curated || !isDefaultEligibleId(curated.id)) {
			throw new Error(
				"Custom model downloads are disabled; choose an Eliza-1 tier from the curated catalog.",
			);
		}
		const modelId = catalogEntry.id;
		this.clearTerminalDownload(modelId);

		const existing = this.active.get(modelId);
		if (
			existing &&
			(existing.job.state === "queued" || existing.job.state === "downloading")
		) {
			return { ...existing.job };
		}

		// Reserve the slot SYNCHRONOUSLY — before any await — so a second
		// concurrent start(sameId) sees it at the check above and returns the same
		// job instead of racing a second write stream onto the same .part file
		// (which corrupts the GGUF). All path derivation is synchronous; the resume
		// offset is filled in after the reservation is held.
		const stagingPath = path.join(
			downloadsStagingDir(),
			stagingFilename(modelId),
		);
		const finalPath = path.join(elizaModelsDir(), finalFilename(catalogEntry));

		const job: DownloadJob = {
			jobId: randomUUID(),
			modelId,
			state: "queued",
			received: 0,
			total: Math.round(catalogEntry.sizeGb * 1024 ** 3),
			bytesPerSec: 0,
			etaMs: null,
			startedAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		};

		const abortController = new AbortController();
		const record: ActiveJob = {
			job,
			abortController,
			stagingPath,
			finalPath,
		};
		this.active.set(modelId, record);

		// Slot is held — now safe to await; a concurrent caller short-circuits above.
		await ensureDirs();
		job.received = await partialSize(stagingPath);

		// Fire-and-forget; errors are captured and emitted as a "failed" event.
		void this.runJob(catalogEntry, record).catch(() => {
			// `runJob` handles its own failure telemetry; we only need to swallow
			// the unhandled-rejection here.
		});

		this.emit({ type: "progress", job: { ...job } });
		return { ...job };
	}

	cancel(modelId: string): boolean {
		const record = this.active.get(modelId);
		if (!record) return false;
		if (record.job.state !== "downloading" && record.job.state !== "queued") {
			return false;
		}
		record.abortController.abort();
		this.updateState(record, "cancelled");
		this.rememberTerminalDownload(record.job);
		this.emit({ type: "cancelled", job: { ...record.job } });
		this.active.delete(modelId);
		return true;
	}

	private emit(event: DownloadEvent): void {
		for (const listener of this.listeners) {
			try {
				listener(event);
			} catch {
				// A bad listener must not kill the downloader; drop it silently.
				this.listeners.delete(listener);
			}
		}
	}

	private updateState(record: ActiveJob, state: DownloadState): void {
		record.job.state = state;
		record.job.updatedAt = new Date().toISOString();
	}

	private loadTerminalDownloads(): void {
		try {
			const raw = fs.readFileSync(terminalDownloadsPath(), "utf8");
			const parsed = JSON.parse(raw) as TerminalDownloadsFile;
			if (parsed?.version !== 1 || !Array.isArray(parsed.jobs)) {
				return;
			}
			for (const job of parsed.jobs) {
				if (
					job &&
					typeof job.modelId === "string" &&
					(job.state === "completed" ||
						job.state === "failed" ||
						job.state === "cancelled")
				) {
					this.terminal.set(job.modelId, { ...job });
				}
			}
		} catch {
			// Missing or malformed terminal-download state should not block
			// local inference. New terminal states will rewrite the file.
		}
	}

	private persistTerminalDownloads(): void {
		try {
			fs.mkdirSync(localInferenceRoot(), { recursive: true });
			const jobs = [...this.terminal.values()]
				.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
				.slice(0, TERMINAL_DOWNLOAD_LIMIT);
			const payload: TerminalDownloadsFile = { version: 1, jobs };
			fs.writeFileSync(
				terminalDownloadsPath(),
				JSON.stringify(payload, null, 2),
				"utf8",
			);
		} catch {
			// Terminal status is useful for chat/UI telemetry but is not allowed to
			// fail the download path.
		}
	}

	private rememberTerminalDownload(job: DownloadJob): void {
		this.terminal.set(job.modelId, { ...job });
		const ordered = [...this.terminal.values()].sort((left, right) =>
			right.updatedAt.localeCompare(left.updatedAt),
		);
		this.terminal.clear();
		for (const terminalJob of ordered.slice(0, TERMINAL_DOWNLOAD_LIMIT)) {
			this.terminal.set(terminalJob.modelId, terminalJob);
		}
		this.persistTerminalDownloads();
	}

	private clearTerminalDownload(modelId: string): void {
		if (!this.terminal.delete(modelId)) return;
		this.persistTerminalDownloads();
	}

	private throttleEmit(record: ActiveJob): void {
		const now = Date.now();
		const last = this.lastEmit.get(record.job.modelId) ?? 0;
		if (now - last < PROGRESS_THROTTLE_MS) return;
		this.lastEmit.set(record.job.modelId, now);
		this.emit({ type: "progress", job: { ...record.job } });
	}

	/**
	 * Disk-space preflight. The remaining download must fit on the models
	 * volume with a small headroom margin, or we fail the job up front with an
	 * actionable message instead of letting it stream gigabytes and die with
	 * ENOSPC near the end. Best-effort: when free disk can't be probed we let
	 * the download proceed (the post-hoc ENOSPC handling still catches it).
	 */
	private async assertDiskSpaceForJob(record: ActiveJob): Promise<void> {
		const remainingBytes = Math.max(0, record.job.total - record.job.received);
		if (remainingBytes <= 0) return;
		let freeDiskGb: number | undefined;
		try {
			const probe = await this.probeHardware();
			freeDiskGb = probe.freeDiskGb ?? probe.mobile?.freeStorageGb ?? undefined;
		} catch {
			return; // probe failure must never block a download
		}
		if (freeDiskGb === undefined) return;
		const requiredGb = remainingBytes / 1024 ** 3 + DISK_HEADROOM_GB;
		if (freeDiskGb < requiredGb) {
			throw new Error(
				`Not enough disk space: this download needs ~${requiredGb.toFixed(1)} GB ` +
					`but only ${freeDiskGb.toFixed(1)} GB is free on the models volume. ` +
					"Free up space and retry.",
			);
		}
	}

	/**
	 * On iOS the on-device runtime streams the model download in-process; if the
	 * device auto-locks, the runtime is suspended and the multi-GB transfer
	 * stalls at "Loading eliza-1-2B…" (#11841). While a download is active, ask
	 * the host app to hold the iOS idle timer open via the native
	 * `keep_awake_set` host function on the `__ELIZA_BRIDGE__` compatibility
	 * bridge (reference-counted natively so overlapping downloads compose).
	 * This removes the common auto-lock stall on the JSContext (sideload/dev)
	 * path; a *manual* lock or backgrounding still needs the native background
	 * `URLSession` download (the tracked #11841 primary fix). The bridge global
	 * — and this host function — are absent on every other platform and on the
	 * full-Bun engine, so this is a safe unconditional no-op there.
	 */
	private setDownloadKeepAwake(active: boolean): void {
		try {
			const bridge = (
				globalThis as {
					__ELIZA_BRIDGE__?: { keep_awake_set?: (on: boolean) => unknown };
				}
			).__ELIZA_BRIDGE__;
			bridge?.keep_awake_set?.(active);
		} catch {
			// Best-effort screen-wake hint; never let it affect the download.
		}
	}

	/**
	 * The native iOS background-`URLSession` download bridge, when the runtime
	 * has installed it (#11841). Present only on iOS; `undefined` everywhere
	 * else, which keeps every other platform on the in-process fetch path.
	 */
	private backgroundDownloadBridge():
		| NativeBackgroundDownloadBridge
		| undefined {
		const bridge = (
			globalThis as {
				__ELIZA_BRIDGE__?: Record<string, unknown>;
			}
		).__ELIZA_BRIDGE__;
		if (
			bridge &&
			typeof bridge.bg_download_start === "function" &&
			typeof bridge.bg_download_status === "function" &&
			typeof bridge.bg_download_cancel === "function"
		) {
			return bridge as unknown as NativeBackgroundDownloadBridge;
		}
		return undefined;
	}

	/**
	 * Download one whole remote file to `targetPath` through the native
	 * background `URLSession` and resolve once the finished file is fully staged
	 * there. The native session owns its own resume across app suspension / lock
	 * (that is the point of #11841), so this path never sends a Range header —
	 * it always targets the complete file and lets the OS resume as needed.
	 * Progress is polled and mapped onto the job's cumulative byte counters; the
	 * caller runs the existing sha256 gate on the staged file. `forceFresh`
	 * discards any resumable/terminal native state for this id first, used when
	 * the sha gate rejects a completed transfer and we must re-fetch from zero.
	 */
	private async transferViaBackgroundSession(args: {
		bridge: NativeBackgroundDownloadBridge;
		downloadId: string;
		url: string;
		headers: Record<string, string>;
		targetPath: string;
		record: ActiveJob;
		baseBytes: number;
		expectedTotalBytes: number;
		forceFresh: boolean;
	}): Promise<void> {
		const {
			bridge,
			downloadId,
			url,
			headers,
			targetPath,
			record,
			baseBytes,
			expectedTotalBytes,
			forceFresh,
		} = args;

		if (forceFresh) {
			await Promise.resolve(
				bridge.bg_download_cancel({ id: downloadId }),
			).catch(() => undefined);
		}

		const started = parseBackgroundStatus(
			await bridge.bg_download_start({
				id: downloadId,
				url,
				headers,
				destPath: targetPath,
				expectedTotalBytes,
			}),
		);
		if (started.state === "failed") {
			throw new Error(
				started.error ??
					`native background download failed to start for ${downloadId}`,
			);
		}

		let lastSampleBytes = record.job.received;
		let lastSampleAt = Date.now();
		for (;;) {
			if (record.abortController.signal.aborted) {
				await Promise.resolve(
					bridge.bg_download_cancel({ id: downloadId }),
				).catch(() => undefined);
				throw makeAbortError();
			}

			const status = parseBackgroundStatus(
				await bridge.bg_download_status({ id: downloadId }),
			);
			const received = status.received ?? 0;
			if (status.total !== undefined && status.total > 0) {
				record.job.total = Math.max(record.job.total, baseBytes + status.total);
			}
			record.job.received = baseBytes + received;

			const now = Date.now();
			const elapsed = now - lastSampleAt;
			if (elapsed >= 1000) {
				record.job.bytesPerSec =
					((record.job.received - lastSampleBytes) * 1000) / elapsed;
				record.job.etaMs =
					record.job.bytesPerSec > 0
						? ((record.job.total - record.job.received) * 1000) /
							record.job.bytesPerSec
						: null;
				lastSampleAt = now;
				lastSampleBytes = record.job.received;
			}
			this.throttleEmit(record);

			if (status.state === "completed") return;
			if (status.state === "cancelled") throw makeAbortError();
			if (status.state === "failed") {
				throw new Error(
					status.error ?? `native background download failed for ${downloadId}`,
				);
			}

			await new Promise((resolve) =>
				setTimeout(resolve, BACKGROUND_DOWNLOAD_POLL_MS),
			);
		}
	}

	private async requestHubFile(args: {
		catalogEntry: CatalogModel;
		remotePath: string;
		headers: Record<string, string>;
		signal: AbortSignal;
	}): Promise<{
		response: {
			statusCode: number;
			headers: Record<string, string | string[] | undefined>;
			body: AsyncIterable<Buffer>;
		};
		candidate: HfResolveUrlCandidate;
	}> {
		const candidates = buildHuggingFaceResolveUrlCandidatesForPath(
			args.catalogEntry,
			args.remotePath,
		);
		const httpClient = await this.loadHttpClient();
		let lastError: unknown;

		for (let index = 0; index < candidates.length; index += 1) {
			const candidate = candidates[index];
			const headers = {
				...args.headers,
				...candidate.authHeader,
			};

			let response: Awaited<ReturnType<typeof httpClient.request>>;
			try {
				response = await httpClient.request(candidate.url, {
					method: "GET",
					headers,
					signal: args.signal,
				});
			} catch (error) {
				lastError = error;
				if (args.signal.aborted || index === candidates.length - 1) {
					throw error;
				}
				logger.warn(
					`[Downloader] model hub request failed via ${candidate.label ?? candidate.base}; trying next base`,
					{ error },
				);
				await sleep(failoverBackoffMs(index));
				continue;
			}

			if (
				isTransientHubStatus(response.statusCode) &&
				index < candidates.length - 1
			) {
				lastError = new Error(
					`HTTP ${response.statusCode} from model hub via ${candidate.label ?? candidate.base}`,
				);
				logger.warn(
					`[Downloader] transient model hub HTTP ${response.statusCode} via ${candidate.label ?? candidate.base}; trying next base`,
				);
				await sleep(failoverBackoffMs(index));
				continue;
			}

			if (response.statusCode >= 400) {
				const body = await readHubErrorBody(response.body);
				if (response.statusCode === 401 || response.statusCode === 403) {
					const gated = parseGatedHubError(body);
					throw new GatedRepoError(
						gatedRepoMessage(
							gated?.repo ?? args.catalogEntry.hfRepo,
							response.statusCode,
						),
						response.statusCode,
					);
				}
				throw new Error(
					`HTTP ${response.statusCode} from model hub for ${args.catalogEntry.hfRepo}/${args.remotePath}`,
				);
			}

			return { response, candidate };
		}

		throw lastError instanceof Error
			? lastError
			: new Error(
					`Failed to download ${args.catalogEntry.hfRepo}/${args.remotePath}`,
				);
	}

	private async transferViaBackgroundSessionWithFailover(args: {
		bridge: NativeBackgroundDownloadBridge;
		catalogEntry: CatalogModel;
		remotePath: string;
		headers: Record<string, string>;
		downloadId: string;
		targetPath: string;
		record: ActiveJob;
		baseBytes: number;
		expectedTotalBytes: number;
		forceFresh: boolean;
	}): Promise<void> {
		const candidates = buildHuggingFaceResolveUrlCandidatesForPath(
			args.catalogEntry,
			args.remotePath,
		);
		let lastError: unknown;
		for (let index = 0; index < candidates.length; index += 1) {
			const candidate = candidates[index];
			try {
				await this.transferViaBackgroundSession({
					bridge: args.bridge,
					downloadId: args.downloadId,
					url: candidate.url,
					headers: { ...args.headers, ...candidate.authHeader },
					targetPath: args.targetPath,
					record: args.record,
					baseBytes: args.baseBytes,
					expectedTotalBytes: args.expectedTotalBytes,
					forceFresh: args.forceFresh || index > 0,
				});
				return;
			} catch (error) {
				lastError = error;
				if (
					args.record.abortController.signal.aborted ||
					index === candidates.length - 1
				) {
					throw error;
				}
				logger.warn(
					`[Downloader] background model hub request failed via ${candidate.label ?? candidate.base}; trying next base`,
					{ error },
				);
				await sleep(failoverBackoffMs(index));
			}
		}
		throw lastError instanceof Error
			? lastError
			: new Error(
					`Failed to download ${args.catalogEntry.hfRepo}/${args.remotePath}`,
				);
	}

	private async runJob(
		catalogEntry: CatalogModel,
		record: ActiveJob,
	): Promise<void> {
		try {
			this.updateState(record, "downloading");
			this.setDownloadKeepAwake(true);
			await this.assertDiskSpaceForJob(record);
			if (catalogEntry.bundleManifestFile) {
				await this.runBundleJob(catalogEntry, record);
				return;
			}

			const headers: Record<string, string> = {
				"user-agent": "Eliza-LocalInference/1.0",
			};

			const backgroundBridge = this.backgroundDownloadBridge();
			if (backgroundBridge) {
				// iOS: route the whole file through the native background
				// URLSession so it survives the app backgrounding / device lock
				// (#11841). The native session owns resume, so no Range header.
				record.job.received = 0;
				await this.transferViaBackgroundSessionWithFailover({
					bridge: backgroundBridge,
					catalogEntry,
					remotePath: catalogEntry.ggufFile,
					downloadId: stagingFilename(record.job.modelId),
					headers,
					targetPath: record.stagingPath,
					record,
					baseBytes: 0,
					expectedTotalBytes: record.job.total,
					forceFresh: false,
				});
			} else {
				const startByte = record.job.received;

				if (startByte > 0) {
					headers.range = `bytes=${startByte}-`;
				}

				const { response } = await this.requestHubFile({
					catalogEntry,
					remotePath: catalogEntry.ggufFile,
					headers,
					signal: record.abortController.signal,
				});
				let effectiveStartByte = startByte;
				if (effectiveStartByte > 0 && response.statusCode !== 206) {
					effectiveStartByte = 0;
					record.job.received = 0;
				}

				const contentLengthHeader = response.headers["content-length"];
				const contentLength = Array.isArray(contentLengthHeader)
					? Number.parseInt(contentLengthHeader[0] ?? "0", 10)
					: Number.parseInt(contentLengthHeader ?? "0", 10);
				if (Number.isFinite(contentLength) && contentLength > 0) {
					record.job.total = effectiveStartByte + contentLength;
				}

				const writeStream: Writable = fs.createWriteStream(record.stagingPath, {
					flags: effectiveStartByte > 0 ? "a" : "w",
				});

				let lastSampleBytes = record.job.received;
				let lastSampleAt = Date.now();

				const bodyStream = Readable.from(response.body);
				bodyStream.on("data", (chunk: Buffer) => {
					record.job.received += chunk.length;

					const now = Date.now();
					const elapsed = now - lastSampleAt;
					if (elapsed >= 1000) {
						record.job.bytesPerSec =
							((record.job.received - lastSampleBytes) * 1000) / elapsed;
						record.job.etaMs =
							record.job.bytesPerSec > 0
								? ((record.job.total - record.job.received) * 1000) /
									record.job.bytesPerSec
								: null;
						lastSampleAt = now;
						lastSampleBytes = record.job.received;
					}

					this.throttleEmit(record);
				});

				await pipeline(bodyStream, writeStream);
			}

			await fsp.rename(record.stagingPath, record.finalPath);

			// Integrity gate: a gated/private repo can answer HTTP 200 with an
			// HTML login/error body, which would otherwise be renamed `<id>.gguf`
			// and registered as an installed model. Reject anything that is not a
			// real GGUF before it enters the registry, and point the user at the
			// likely cause (gated bundles resolve through the Eliza Cloud HF
			// proxy, so the device must be linked to Eliza Cloud).
			if (!(await hasGgufMagic(record.finalPath))) {
				await fsp.rm(record.finalPath, { force: true }).catch(() => undefined);
				throw new Error(
					`Downloaded file for ${catalogEntry.hfRepo ?? catalogEntry.id} is not a valid GGUF ` +
						"(it looks like an auth/redirect page, not a model). If the bundle is gated, " +
						"link this device to Eliza Cloud and retry — gated downloads route through " +
						"the cloud HuggingFace proxy.",
				);
			}

			const finalStat = await fsp.stat(record.finalPath);
			// Compute SHA256 on commit so we have an integrity baseline. The
			// chunk hasher we maintain during streaming gives the same result
			// but would also have to handle resume-from-partial correctly; for
			// a ~1-20 GB file a second disk pass at the end is simpler and
			// robust. Measured at ~400 MB/s on an NVMe so even the 20 GB
			// catalog entries finish in well under a minute.
			const sha256 = await hashFile(record.finalPath);

			const installed: InstalledModel = {
				id: catalogEntry.id,
				displayName: catalogEntry.displayName,
				path: record.finalPath,
				sizeBytes: finalStat.size,
				hfRepo: catalogEntry.hfRepo,
				installedAt: new Date().toISOString(),
				lastUsedAt: null,
				source: "eliza-download",
				sha256,
				lastVerifiedAt: new Date().toISOString(),
				runtimeClass: classifyCatalogModelRuntimeClass(catalogEntry),
				...(catalogEntry.runtimeRole
					? { runtimeRole: catalogEntry.runtimeRole }
					: {}),
			};
			await upsertElizaModel(installed);

			// First-light convenience: only default-eligible Eliza-1 downloads
			// can fill empty slots.
			if (isDefaultEligibleId(installed.id)) {
				await ensureDefaultAssignment(installed.id);
			}

			this.updateState(record, "completed");
			record.job.received = finalStat.size;
			record.job.total = finalStat.size;
			this.rememberTerminalDownload(record.job);
			this.emit({ type: "completed", job: { ...record.job } });
		} catch (err) {
			if (record.abortController.signal.aborted) {
				this.updateState(record, "cancelled");
				this.rememberTerminalDownload(record.job);
				this.emit({ type: "cancelled", job: { ...record.job } });
			} else {
				this.updateState(record, "failed");
				record.job.error = err instanceof Error ? err.message : String(err);
				// Propagate a typed failure so the consumer (download-status /
				// UI) can key recovery off a machine-readable code instead of
				// string-matching `error`. A stringified message loses the code.
				if (err instanceof GatedRepoError) {
					record.job.errorCode = err.code;
					record.job.errorHttpStatus = err.httpStatus;
				}
				this.rememberTerminalDownload(record.job);
				this.emit({ type: "failed", job: { ...record.job } });
			}
		} finally {
			this.setDownloadKeepAwake(false);
			this.active.delete(record.job.modelId);
		}
	}

	private async runBundleJob(
		catalogEntry: CatalogModel,
		record: ActiveJob,
	): Promise<void> {
		if (!catalogEntry.bundleManifestFile) {
			throw new Error(
				`[local-inference] ${catalogEntry.id} has no bundle manifest`,
			);
		}

		const bundleRoot = path.join(
			elizaModelsDir(),
			bundleDirname(catalogEntry.id),
		);
		await fsp.mkdir(bundleRoot, { recursive: true });

		const manifestPath = bundleTargetPath(
			bundleRoot,
			catalogEntry.bundleManifestFile,
		);
		const manifestDownloaded = await this.downloadRemotePath(
			catalogEntry,
			catalogEntry.bundleManifestFile,
			path.join(
				downloadsStagingDir(),
				bundleStagingFilename(catalogEntry.id, catalogEntry.bundleManifestFile),
			),
			manifestPath,
			record,
			0,
			catalogEntry.bundleManifestSha256,
		);

		const manifest = parseBundleManifestOrThrow(
			JSON.parse(await fsp.readFile(manifestPath, "utf8")),
			catalogEntry,
		);

		// §7: schema version, RAM budget, and kernel-backend availability are
		// checked against this device BEFORE any weight byte is fetched. An
		// incompatible bundle aborts here — there is no "download anyway" path.
		const deviceCaps = await this.probeDeviceCaps();
		assertBundleInstallable(manifest, deviceCaps);

		let completedBytes = manifestDownloaded.sizeBytes;
		const downloaded = new Map<string, DownloadedFile>();
		for (const { entry } of collectBundleFiles(manifest)) {
			const finalPath = bundleTargetPath(bundleRoot, entry.path);
			const result = await this.downloadRemotePath(
				catalogEntry,
				entry.path,
				path.join(
					downloadsStagingDir(),
					bundleStagingFilename(catalogEntry.id, entry.path),
				),
				finalPath,
				record,
				completedBytes,
				entry.sha256,
			);
			downloaded.set(entry.path, result);
			completedBytes += result.sizeBytes;
			record.job.received = completedBytes;
			record.job.total = Math.max(record.job.total, completedBytes);
			this.throttleEmit(record);
		}

		// Fused-lib bundle delivery (#9105): fetch the host-matching native-lib
		// SET into `<bundleRoot>/lib/`, which the desktop FFI runtime resolves
		// with no env wiring (`resolveFusedLibraryPath` path #2). Only entries
		// whose `target` matches the host are fetched; no `lib[]` / no host match
		// ⇒ skipped (the runtime falls back to a host-staged lib dir, else cloud).
		// Mobile resolves to no targets — phones ship the lib natively.
		// Prefer the GPU lib target when this device actually has a CUDA backend
		// (NVIDIA), so a CUDA-capable host pulls the accelerated set when the
		// bundle hosts one; everything else takes the CPU baseline. macOS arm64
		// already resolves to the metal set (which carries the CPU fallback).
		const preferGpu = deviceCaps.availableBackends.includes("cuda");
		const selectedLib = selectBundleLibFiles(
			manifest,
			resolveHostLibTargets({ preferGpu }),
		);
		if (selectedLib) {
			for (const libEntry of selectedLib.files) {
				const relPath = `lib/${libStagedName(libEntry)}`;
				const result = await this.downloadRemotePath(
					catalogEntry,
					libEntry.path,
					path.join(
						downloadsStagingDir(),
						bundleStagingFilename(catalogEntry.id, relPath),
					),
					bundleTargetPath(bundleRoot, relPath),
					record,
					completedBytes,
					libEntry.sha256,
				);
				completedBytes += result.sizeBytes;
				record.job.received = completedBytes;
				record.job.total = Math.max(record.job.total, completedBytes);
				this.throttleEmit(record);
			}
			logger.info(
				`[local-inference] staged fused lib set for ${catalogEntry.id} ` +
					`(target=${selectedLib.target}, ${selectedLib.files.length} file(s)) → ${bundleRoot}/lib`,
			);
		}

		const textEntry = manifest.files.text.find(
			(entry) => entry.path === catalogEntry.ggufFile,
		);
		if (!textEntry) {
			throw new Error(
				`[local-inference] Bundle missing primary text file ${catalogEntry.ggufFile}`,
			);
		}
		const textFile = downloaded.get(textEntry.path);
		if (!textFile) {
			throw new Error(
				`[local-inference] Bundle did not install text file ${textEntry.path}`,
			);
		}

		// §7: materialize the bundle, then run the one-time verify-on-device
		// pass before the bundle is treated as ready. The hook is injected by
		// the service layer so the downloader stays decoupled from the engine.
		// When no hook is wired, `bundleVerifiedAt` stays unset and the bundle
		// is registered but does NOT auto-fill an empty default slot.
		let bundleVerifiedAt: string | undefined;
		if (this.verifyOnDevice) {
			await this.verifyOnDevice({
				modelId: catalogEntry.id,
				bundleRoot,
				manifestPath,
				textGgufPath: textFile.path,
			});
			bundleVerifiedAt = new Date().toISOString();
		}

		const now = new Date().toISOString();
		const bundleMeta = {
			bundleRoot,
			manifestPath,
			manifestSha256: manifestDownloaded.sha256,
			bundleVersion: manifest.version,
			bundleSizeBytes: completedBytes,
			...(bundleVerifiedAt ? { bundleVerifiedAt } : {}),
		};

		const installed: InstalledModel = {
			id: catalogEntry.id,
			displayName: catalogEntry.displayName,
			path: textFile.path,
			sizeBytes: textFile.sizeBytes,
			hfRepo: catalogEntry.hfRepo,
			installedAt: now,
			lastUsedAt: null,
			source: "eliza-download",
			sha256: textFile.sha256,
			lastVerifiedAt: now,
			runtimeClass: classifyCatalogModelRuntimeClass(catalogEntry),
			...bundleMeta,
		};
		await upsertElizaModel(installed);

		// An empty default slot is filled only after the on-device verify pass
		// succeeds. Without a verify hook the bundle is installed and visible,
		// but it is not allowed to auto-fill defaults.
		if (isDefaultEligibleId(installed.id) && bundleVerifiedAt !== undefined) {
			await ensureDefaultAssignment(installed.id);
		}

		this.updateState(record, "completed");
		record.job.received = completedBytes;
		record.job.total = completedBytes;
		this.rememberTerminalDownload(record.job);
		this.emit({ type: "completed", job: { ...record.job } });
	}

	private async downloadRemotePath(
		catalogEntry: CatalogModel,
		remotePath: string,
		stagingPath: string,
		finalPath: string,
		record: ActiveJob,
		baseBytes: number,
		expectedSha256?: string,
	): Promise<DownloadedFile> {
		if (expectedSha256) {
			try {
				const stat = await fsp.stat(finalPath);
				if (stat.isFile()) {
					const currentSha256 = await hashFile(finalPath);
					if (currentSha256 === expectedSha256) {
						record.job.received = baseBytes + stat.size;
						return {
							path: finalPath,
							sizeBytes: stat.size,
							sha256: currentSha256,
						};
					}
					// Same filename, different content: the hub re-published this
					// path. The stale blob must never be kept — discard and re-fetch.
					logger.warn(
						`[Downloader] stale ${remotePath} on disk ` +
							`(sha256 ${currentSha256.slice(0, 12)}… != manifest ${expectedSha256.slice(0, 12)}…); re-downloading`,
					);
					await fsp.rm(finalPath, { force: true });
				}
			} catch {
				// Missing files are downloaded below; unreadable stale files are
				// treated as invalid and replaced by the fresh bundle artifact.
			}
		} else {
			await fsp.rm(stagingPath, { force: true }).catch(() => undefined);
		}

		await fsp.mkdir(path.dirname(finalPath), { recursive: true });
		await fsp.mkdir(path.dirname(stagingPath), { recursive: true });

		const backgroundBridge = this.backgroundDownloadBridge();
		const maxAttempts = expectedSha256 ? SHA_MISMATCH_MAX_ATTEMPTS : 1;
		for (let attempt = 1; ; attempt++) {
			const headers: Record<string, string> = {
				"user-agent": "Eliza-LocalInference/1.0",
			};

			if (backgroundBridge) {
				// iOS: the whole file goes through the native background
				// URLSession, which owns its own resume across suspension /
				// lock (#11841). A sha-mismatch retry (attempt > 1) re-fetches
				// from zero; the first attempt may reuse a completed transfer
				// that outlived a runtime restart.
				record.job.received = baseBytes;
				await this.transferViaBackgroundSessionWithFailover({
					bridge: backgroundBridge,
					catalogEntry,
					remotePath,
					downloadId: path.basename(stagingPath),
					headers,
					targetPath: stagingPath,
					record,
					baseBytes,
					expectedTotalBytes: 0,
					forceFresh: attempt > 1,
				});
				await fsp.rename(stagingPath, finalPath);
			} else {
				let startByte = 0;
				if (expectedSha256) {
					startByte = await resumableStartByte(stagingPath, expectedSha256);
					// Stamp the partial with the content hash it is being fetched
					// against so a later resume can tell whether the .part still
					// belongs to THIS content version.
					await fsp.writeFile(
						stagingMetaPath(stagingPath),
						expectedSha256,
						"utf8",
					);
				}
				record.job.received = baseBytes + startByte;

				if (startByte > 0) {
					headers.range = `bytes=${startByte}-`;
				}

				const { response } = await this.requestHubFile({
					catalogEntry,
					remotePath,
					headers,
					signal: record.abortController.signal,
				});
				if (startByte > 0 && response.statusCode !== 206) {
					startByte = 0;
					record.job.received = baseBytes;
				}

				const contentLengthHeader = response.headers["content-length"];
				const contentLength = Array.isArray(contentLengthHeader)
					? Number.parseInt(contentLengthHeader[0] ?? "0", 10)
					: Number.parseInt(contentLengthHeader ?? "0", 10);
				if (Number.isFinite(contentLength) && contentLength > 0) {
					record.job.total = Math.max(
						record.job.total,
						baseBytes + startByte + contentLength,
					);
				}

				const writeStream: Writable = fs.createWriteStream(stagingPath, {
					flags: startByte > 0 ? "a" : "w",
				});

				let lastSampleBytes = record.job.received;
				let lastSampleAt = Date.now();
				const bodyStream = Readable.from(response.body);
				bodyStream.on("data", (chunk: Buffer) => {
					record.job.received += chunk.length;

					const now = Date.now();
					const elapsed = now - lastSampleAt;
					if (elapsed >= 1000) {
						record.job.bytesPerSec =
							((record.job.received - lastSampleBytes) * 1000) / elapsed;
						record.job.etaMs =
							record.job.bytesPerSec > 0
								? ((record.job.total - record.job.received) * 1000) /
									record.job.bytesPerSec
								: null;
						lastSampleAt = now;
						lastSampleBytes = record.job.received;
					}

					this.throttleEmit(record);
				});

				await pipeline(bodyStream, writeStream);
				await fsp.rename(stagingPath, finalPath);
			}

			const stat = await fsp.stat(finalPath);
			const sha256 = await hashFile(finalPath);
			await fsp
				.rm(stagingMetaPath(stagingPath), { force: true })
				.catch(() => undefined);
			if (expectedSha256 && sha256 !== expectedSha256) {
				// Wrong bytes must never stay on disk under the final name.
				await fsp.rm(finalPath, { force: true });
				if (attempt < maxAttempts) {
					logger.warn(
						`[Downloader] SHA256 mismatch for bundle file ${remotePath} ` +
							`(attempt ${attempt}/${maxAttempts}); re-fetching from scratch`,
					);
					continue;
				}
				throw new Error(
					`SHA256 mismatch for bundle file ${remotePath} after ${maxAttempts} attempts`,
				);
			}
			return { path: finalPath, sizeBytes: stat.size, sha256 };
		}
	}

	private async loadHttpClient(): Promise<{
		request: (
			url: string,
			options: {
				method: string;
				headers: Record<string, string>;
				signal: AbortSignal;
			},
		) => Promise<{
			statusCode: number;
			headers: Record<string, string | string[] | undefined>;
			body: AsyncIterable<Buffer>;
		}>;
	}> {
		const fetchImpl = globalThis.fetch;
		const sleep = this.sleep;
		return {
			request: async (url, options) => {
				// Retry transient upstream statuses (429 rate-limit, 5xx) with bounded
				// backoff before surfacing them. Without this a single HuggingFace
				// throttle aborts a multi-GB download exactly like a hard 404.
				let response: Awaited<ReturnType<typeof fetchImpl>> | null = null;
				for (
					let attempt = 1;
					attempt <= DOWNLOAD_TRANSIENT_ATTEMPTS;
					attempt += 1
				) {
					response = await fetchImpl(url, {
						method: options.method,
						headers: options.headers,
						signal: options.signal,
						redirect: "follow",
					});
					if (
						!isTransientStatus(response.status) ||
						attempt === DOWNLOAD_TRANSIENT_ATTEMPTS
					) {
						break;
					}
					const headers = Object.fromEntries(response.headers.entries());
					// Release the throttled body before re-issuing the request.
					await response.body?.cancel().catch(() => undefined);
					await sleep(
						retryAfterMs(headers) ?? DOWNLOAD_TRANSIENT_BACKOFF_MS * attempt,
					);
				}
				if (!response) {
					throw new Error(`No response from ${url}`);
				}
				if (!response.body) {
					throw new Error(`Empty response body from ${url}`);
				}
				return {
					statusCode: response.status,
					headers: Object.fromEntries(response.headers.entries()),
					body: readFetchBody(response.body),
				};
			},
		};
	}
}
