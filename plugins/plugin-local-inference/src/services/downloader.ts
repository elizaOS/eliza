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
	buildHuggingFaceResolveUrl,
	buildHuggingFaceResolveUrlForPath,
	findCatalogModel,
	isDefaultEligibleId,
	resolveHfDownloadBase,
} from "./catalog";
import { deviceCapsFromProbe, probeHardware } from "./hardware";
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

/**
 * Embedded-draft-head MTP cutover (#9033). The published 2b/4b stand-in bundles
 * still ship a legacy *separate* MTP drafter (`files.mtp` + `lineage.drafter`),
 * which the current manifest validator rejects for these embedded-draft-head
 * tiers. Normalize such a fetched manifest in place to embedded-draft-head: drop
 * the separate drafter so the bundle validates and installs (MTP runs via the
 * head embedded in the text GGUF; the drafter companion is simply not
 * downloaded). Returns true if it changed anything. No-op for already-embedded
 * manifests.
 */
function normalizeEmbeddedDraftHeadManifest(raw: unknown): boolean {
	if (!raw || typeof raw !== "object") return false;
	const m = raw as {
		files?: Record<string, unknown>;
		lineage?: Record<string, unknown>;
	};
	let changed = false;
	if (m.files && Array.isArray(m.files.mtp) && m.files.mtp.length > 0) {
		m.files.mtp = [];
		changed = true;
	}
	if (m.lineage && m.lineage.drafter != null) {
		delete m.lineage.drafter;
		changed = true;
	}
	// GGUF/ggml only inside eliza — strip any ONNX artifact from the bundle. The
	// fused FFI runtime never loads ONNX; published bundles sometimes list an
	// alternate `.onnx` variant (e.g. `vad/silero-vad-int8.onnx`) alongside the
	// canonical `.gguf`. Drop them so the bundle is GGUF-only.
	if (m.files) {
		for (const kind of Object.keys(m.files)) {
			const arr = m.files[kind];
			if (!Array.isArray(arr)) continue;
			const filtered = arr.filter(
				(e) =>
					!(
						e &&
						typeof e === "object" &&
						typeof (e as { path?: unknown }).path === "string" &&
						(e as { path: string }).path.toLowerCase().endsWith(".onnx")
					),
			);
			if (filtered.length !== arr.length) {
				m.files[kind] = filtered;
				changed = true;
			}
		}
	}
	return changed;
}

/**
 * Remove the given bundle-relative paths from every `files.<kind>` array of a
 * raw manifest object. Used to keep the persisted manifest consistent with what
 * actually installed when a published stand-in bundle lists secondary artifacts
 * (e.g. an alternate ONNX VAD variant) that 404 on the hub.
 */
function pruneManifestFiles(raw: unknown, removePaths: string[]): void {
	if (!raw || typeof raw !== "object") return;
	const files = (raw as { files?: Record<string, unknown> }).files;
	if (!files) return;
	const remove = new Set(removePaths);
	for (const kind of Object.keys(files)) {
		const arr = files[kind];
		if (Array.isArray(arr)) {
			files[kind] = arr.filter(
				(e) =>
					!(
						e &&
						typeof e === "object" &&
						remove.has((e as { path?: string }).path ?? "")
					),
			);
		}
	}
}

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

function bundleDirname(modelId: string): string {
	const safe = modelId.replace(/[^a-zA-Z0-9._-]/g, "_");
	return `${safe}.bundle`;
}

function bundleStagingFilename(modelId: string, filePath: string): string {
	const safePath = filePath.replace(/[^a-zA-Z0-9._-]/g, "_");
	return stagingFilename(`${modelId}__${safePath}`);
}

function bundleTargetPath(root: string, filePath: string): string {
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

function parseBundleManifestOrThrow(
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

function collectBundleFiles(
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

export class Downloader {
	private readonly active = new Map<string, ActiveJob>();
	private readonly terminal = new Map<string, DownloadJob>();
	private readonly listeners = new Set<DownloadListener>();
	private readonly lastEmit = new Map<string, number>();
	private readonly probeDeviceCaps: () => Promise<Eliza1DeviceCaps>;
	private readonly verifyOnDevice?: VerifyBundleOnDevice;
	private readonly probeHardware: () => Promise<HardwareProbe>;

	constructor(options: DownloaderOptions = {}) {
		this.probeDeviceCaps = options.probeDeviceCaps ?? defaultProbeDeviceCaps;
		this.verifyOnDevice = options.verifyOnDevice;
		this.probeHardware = options.probeHardware ?? probeHardware;
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

	private async runJob(
		catalogEntry: CatalogModel,
		record: ActiveJob,
	): Promise<void> {
		try {
			this.updateState(record, "downloading");
			await this.assertDiskSpaceForJob(record);
			if (catalogEntry.bundleManifestFile) {
				await this.runBundleJob(catalogEntry, record);
				return;
			}

			const url = buildHuggingFaceResolveUrl(catalogEntry);

			const httpClient = await this.loadHttpClient();
			const startByte = record.job.received;

			const headers: Record<string, string> = {
				"user-agent": "Eliza-LocalInference/1.0",
				...resolveHfDownloadBase().authHeader,
			};
			if (startByte > 0) {
				headers.range = `bytes=${startByte}-`;
			}

			const response = await httpClient.request(url, {
				method: "GET",
				headers,
				signal: record.abortController.signal,
			});

			if (response.statusCode >= 400) {
				throw new Error(
					`HTTP ${response.statusCode} from model hub for ${catalogEntry.hfRepo}`,
				);
			}
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
				this.rememberTerminalDownload(record.job);
				this.emit({ type: "failed", job: { ...record.job } });
			}
		} finally {
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

		const rawManifest = JSON.parse(await fsp.readFile(manifestPath, "utf8"));
		if (normalizeEmbeddedDraftHeadManifest(rawManifest)) {
			// Persist the normalized manifest so the installed bundle is internally
			// consistent (no dangling reference to an un-downloaded drafter).
			await fsp.writeFile(
				manifestPath,
				`${JSON.stringify(rawManifest, null, 2)}\n`,
			);
			logger.warn(
				`[local-inference] ${catalogEntry.id}: normalized a legacy separate-drafter manifest to embedded-draft-head MTP (#9033) — dropped files.mtp + lineage.drafter; the separate drafter companion is not downloaded`,
			);
		}
		const manifest = parseBundleManifestOrThrow(rawManifest, catalogEntry);

		// §7: schema version, RAM budget, and kernel-backend availability are
		// checked against this device BEFORE any weight byte is fetched. An
		// incompatible bundle aborts here — there is no "download anyway" path.
		assertBundleInstallable(manifest, await this.probeDeviceCaps());

		let completedBytes = manifestDownloaded.sizeBytes;
		const downloaded = new Map<string, DownloadedFile>();
		const skippedMissing: string[] = [];
		for (const { entry } of collectBundleFiles(manifest)) {
			const finalPath = bundleTargetPath(bundleRoot, entry.path);
			let result: DownloadedFile;
			try {
				result = await this.downloadRemotePath(
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
			} catch (err) {
				// Tolerate a missing (404) NON-PRIMARY bundle file. The published 2b/4b
				// stand-in bundles list secondary artifacts (e.g. an alternate ONNX VAD
				// variant) that were never uploaded to the hub; skip them so the bundle
				// still installs. The fused desktop runtime uses the GGUF variants; the
				// primary text GGUF is still required (verified below).
				const msg = err instanceof Error ? err.message : String(err);
				if (msg.includes("HTTP 404") && entry.path !== catalogEntry.ggufFile) {
					skippedMissing.push(entry.path);
					logger.warn(
						`[local-inference] ${catalogEntry.id}: skipping missing bundle file ${entry.path} (404 on hub)`,
					);
					continue;
				}
				throw err;
			}
			downloaded.set(entry.path, result);
			completedBytes += result.sizeBytes;
			record.job.received = completedBytes;
			record.job.total = Math.max(record.job.total, completedBytes);
			this.throttleEmit(record);
		}
		if (skippedMissing.length > 0) {
			// Keep the installed manifest consistent with what is on disk.
			pruneManifestFiles(rawManifest, skippedMissing);
			await fsp.writeFile(
				manifestPath,
				`${JSON.stringify(rawManifest, null, 2)}\n`,
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

		let startByte = expectedSha256 ? await partialSize(stagingPath) : 0;
		record.job.received = baseBytes + startByte;

		const url = buildHuggingFaceResolveUrlForPath(catalogEntry, remotePath);
		const headers: Record<string, string> = {
			"user-agent": "Eliza-LocalInference/1.0",
			...resolveHfDownloadBase().authHeader,
		};
		if (startByte > 0) {
			headers.range = `bytes=${startByte}-`;
		}

		const httpClient = await this.loadHttpClient();
		const response = await httpClient.request(url, {
			method: "GET",
			headers,
			signal: record.abortController.signal,
		});

		if (response.statusCode >= 400) {
			throw new Error(
				`HTTP ${response.statusCode} from model hub for ${catalogEntry.hfRepo}/${remotePath}`,
			);
		}
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

		const stat = await fsp.stat(finalPath);
		const sha256 = await hashFile(finalPath);
		if (expectedSha256 && sha256 !== expectedSha256) {
			await fsp.rm(finalPath, { force: true });
			throw new Error(`SHA256 mismatch for bundle file ${remotePath}`);
		}
		return { path: finalPath, sizeBytes: stat.size, sha256 };
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
		return {
			request: async (url, options) => {
				const response = await fetchImpl(url, {
					method: options.method,
					headers: options.headers,
					signal: options.signal,
					redirect: "follow",
				});
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
