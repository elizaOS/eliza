/**
 * Voice sub-model auto-updater (per R5-versioning §3).
 *
 * Watches for newer versions of the voice sub-models declared in
 * `@elizaos/shared/local-inference/voice-models` (`VOICE_MODEL_VERSIONS`)
 * and recommends downloads when the published-side history advertises a
 * strictly newer semver, the publish gate set `netImprovement === true`,
 * and the user has not pinned the installed model.
 *
 * Source cascade (first that responds wins):
 *
 * 1. **Eliza Cloud catalog** — `GET <cloudBaseUrl>/api/v1/voice-models/catalog`
 *    (signed Ed25519, current+next-key rotation). Preferred when the device
 *    is linked to Cloud.
 * 2. **GitHub Releases of `elizaOS/eliza-1-voice-models`** — one release per
 *    `<voiceModelId>-v<version>` tag. Public, unauthenticated (60/h rate
 *    limit; cache aggressively).
 * 3. **HuggingFace tree-listing** — `GET https://huggingface.co/api/models/<hfRepo>/tree/<revision>?recursive=true`.
 *    Final-truth probe; used when the catalog can't be reached.
 *
 * The local in-binary `VOICE_MODEL_VERSIONS` is always consulted alongside
 * the remote sources so a build that ships a newer-than-remote version
 * still wins the comparison (we never auto-downgrade).
 *
 * Cadence: 4 hours (`ELIZA_VOICE_UPDATE_INTERVAL_MS` overrides; defaults to
 * 14_400_000 ms, mirroring `update-checker.ts`).
 *
 * Decision: see `shouldAutoUpdateVoiceModel`.
 *
 * Atomic swap: downloads write to `<staging>/<id>-<version>.part`, hash
 * against the catalog sha256, then `fsp.rename` into the bundle voice dir.
 * On verify failure the staging file is unlinked and the failure is
 * surfaced; no automatic retry (avoid update loops on a flaky CDN).
 *
 * This module is platform-agnostic — it does NOT call the network-policy
 * bridge directly; callers compose the policy decision before invoking
 * `downloadVoiceModel`.
 */

import fsp from "node:fs/promises";
import path from "node:path";
import {
	compareVoiceModelSemver,
	type Ed25519PublicKey,
	hashFile,
	type NetworkPolicyDecision,
	VOICE_MODEL_VERSIONS,
	type VoiceModelId,
	type VoiceModelVersion,
	verifyManifestSignatureText,
} from "@elizaos/shared";

const DEFAULT_CHECK_INTERVAL_MS = 14_400_000; // 4 hours
const DEFAULT_HTTP_TIMEOUT_MS = 8_000;
const CATALOG_SIGNATURE_HEADER = "X-Eliza-Signature";

/**
 * One remote source consulted by the cascade. Tests inject custom shapes;
 * production wires the three sources below.
 */
export interface VoiceModelCatalogSource {
	readonly id: "cloud" | "github" | "huggingface" | (string & {});
	fetchAll(signal: AbortSignal): Promise<ReadonlyArray<VoiceModelVersion>>;
}

export interface VoiceModelPinPolicy {
	/** Set of `VoiceModelId`s pinned to their currently-installed version. */
	readonly pinned: ReadonlySet<VoiceModelId>;
}

export interface VoiceModelUpdateCheckResult {
	readonly id: VoiceModelId;
	readonly installedVersion: string | null;
	readonly latestVersion: VoiceModelVersion | null;
	readonly updateAvailable: boolean;
	readonly pinned: boolean;
	readonly reason:
		| "up-to-date"
		| "pinned"
		| "not-installed"
		| "net-regression"
		| "bundle-incompatible"
		| "update-available";
}

export interface VoiceModelUpdaterOptions {
	/**
	 * Catalog sources in priority order. The first source that returns a
	 * non-empty list wins; sources that throw or return empty are skipped.
	 * Defaults to `[cloud(cloudBaseUrl), github(), huggingface()]`.
	 */
	readonly sources?: ReadonlyArray<VoiceModelCatalogSource>;
	/** Eliza Cloud root URL (e.g. `https://cloud.elizaos.ai`). */
	readonly cloudBaseUrl?: string;
	/** Ed25519 public keys accepted for the Cloud catalog. */
	readonly publicKeys?: ReadonlyArray<Ed25519PublicKey>;
	/** Optional logger for trace events. */
	readonly logger?: {
		info: (msg: string) => void;
		warn: (msg: string) => void;
	};
}

/**
 * Decide whether a candidate version should auto-update over the installed
 * one. Three required gates:
 *
 * 1. candidate version > installed version (semver compare > 0).
 * 2. `candidate.evalDeltas.netImprovement === true`.
 * 3. installed bundle.version ≥ `candidate.minBundleVersion` (caller passes
 *    `bundleVersion`; pass an empty string to skip the bundle gate, e.g.
 *    during pure UI listing).
 *
 * A pinned id always declines.
 */
export function shouldAutoUpdateVoiceModel(args: {
	installedVersion: string | null;
	candidate: VoiceModelVersion;
	bundleVersion: string;
	pinned: boolean;
}): { allow: boolean; reason: VoiceModelUpdateCheckResult["reason"] } {
	if (args.pinned) return { allow: false, reason: "pinned" };
	if (args.installedVersion === null) {
		return { allow: false, reason: "not-installed" };
	}
	const cmp = compareVoiceModelSemver(
		args.candidate.version,
		args.installedVersion,
	);
	if (cmp === null || cmp <= 0) {
		return { allow: false, reason: "up-to-date" };
	}
	if (!args.candidate.evalDeltas.netImprovement) {
		return { allow: false, reason: "net-regression" };
	}
	if (args.bundleVersion !== "") {
		const bundleCmp = compareVoiceModelSemver(
			args.bundleVersion,
			args.candidate.minBundleVersion,
		);
		if (bundleCmp === null || bundleCmp < 0) {
			return { allow: false, reason: "bundle-incompatible" };
		}
	}
	return { allow: true, reason: "update-available" };
}

/**
 * Walk the cascade in order, return the first source that yields a
 * non-empty list. All sources are awaited with `signal` so the caller can
 * cancel the whole check. Sources that throw are logged and skipped.
 *
 * Re-exported as `fetchVoiceModelCatalog` for tests; production callers go
 * through `VoiceModelUpdater.check`.
 */
export async function fetchVoiceModelCatalog(
	sources: ReadonlyArray<VoiceModelCatalogSource>,
	signal: AbortSignal,
	logger?: VoiceModelUpdaterOptions["logger"],
): Promise<{
	source: string;
	versions: ReadonlyArray<VoiceModelVersion>;
} | null> {
	for (const source of sources) {
		if (signal.aborted) return null;
		try {
			const versions = await source.fetchAll(signal);
			if (versions.length > 0) {
				logger?.info(
					`[voice-model-updater] catalog from ${source.id}: ${versions.length} versions`,
				);
				return { source: source.id, versions };
			}
			logger?.info(`[voice-model-updater] ${source.id} returned empty`);
		} catch (err) {
			logger?.warn(
				`[voice-model-updater] ${source.id} failed: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}
	return null;
}

/**
 * Cloud catalog source (R5 §3.1.1). Fetches the signed JSON manifest and
 * verifies it before parsing. Strict — a body whose signature does not
 * verify is treated as a fetch failure so the cascade moves on rather than
 * silently accepting an unsigned response.
 */
export function cloudCatalogSource(args: {
	baseUrl: string;
	publicKeys: ReadonlyArray<Ed25519PublicKey>;
	authToken?: string;
	timeoutMs?: number;
}): VoiceModelCatalogSource {
	return {
		id: "cloud",
		async fetchAll(
			signal: AbortSignal,
		): Promise<ReadonlyArray<VoiceModelVersion>> {
			const url = `${args.baseUrl.replace(/\/$/, "")}/api/v1/voice-models/catalog`;
			const headers: Record<string, string> = {
				Accept: "application/json",
			};
			if (args.authToken) {
				headers.Authorization = `Bearer ${args.authToken}`;
			}
			const timed = withTimeout(
				signal,
				args.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS,
			);
			try {
				const res = await fetch(url, { headers, signal: timed.signal });
				if (!res.ok) {
					throw new Error(`HTTP ${res.status}`);
				}
				const signature = res.headers.get(CATALOG_SIGNATURE_HEADER);
				if (!signature) {
					throw new Error(`missing ${CATALOG_SIGNATURE_HEADER} header`);
				}
				const body = await res.text();
				await verifyManifestSignatureText(body, signature, args.publicKeys);
				const parsed = JSON.parse(body) as { versions?: VoiceModelVersion[] };
				return Array.isArray(parsed.versions) ? parsed.versions : [];
			} finally {
				timed.dispose();
			}
		},
	};
}

/**
 * GitHub releases source (R5 §3.1.2). One release per `<id>-v<version>`
 * tag in `elizaOS/eliza-1-voice-models`. Each release asset includes a
 * `manifest.json` matching the `VoiceModelVersion` shape.
 */
export function githubReleasesSource(args: {
	owner?: string;
	repo?: string;
	timeoutMs?: number;
	authToken?: string;
}): VoiceModelCatalogSource {
	const owner = args.owner ?? "elizaOS";
	const repo = args.repo ?? "eliza-1-voice-models";
	return {
		id: "github",
		async fetchAll(
			signal: AbortSignal,
		): Promise<ReadonlyArray<VoiceModelVersion>> {
			const url = `https://api.github.com/repos/${owner}/${repo}/releases?per_page=100`;
			const headers: Record<string, string> = {
				Accept: "application/vnd.github+json",
				"X-GitHub-Api-Version": "2022-11-28",
			};
			if (args.authToken) {
				headers.Authorization = `Bearer ${args.authToken}`;
			}
			const timed = withTimeout(
				signal,
				args.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS,
			);
			try {
				const res = await fetch(url, { headers, signal: timed.signal });
				if (!res.ok) {
					throw new Error(`HTTP ${res.status}`);
				}
				const releases = (await res.json()) as Array<{
					tag_name: string;
					body?: string;
					assets?: Array<{ name: string; browser_download_url: string }>;
				}>;
				const out: VoiceModelVersion[] = [];
				for (const release of releases) {
					const manifestAsset = release.assets?.find(
						(a) => a.name === "manifest.json",
					);
					if (!manifestAsset) continue;
					try {
						const mRes = await fetch(manifestAsset.browser_download_url, {
							signal: timed.signal,
							headers,
						});
						if (!mRes.ok) continue;
						const parsed = (await mRes.json()) as VoiceModelVersion;
						if (parsed && typeof parsed.id === "string") {
							out.push(parsed);
						}
					} catch {
						// One bad release should not poison the whole list.
					}
				}
				return out;
			} finally {
				timed.dispose();
			}
		},
	};
}

/**
 * HuggingFace tree-listing source (R5 §3.1.3). Final-truth probe. Walks
 * every model id in `VOICE_MODEL_VERSIONS` against its `hfRepo` + `main`
 * revision and re-confirms file shas. This source is best-effort — when
 * HF responds with the file list but no `lfs.sha256` field, the candidate
 * is dropped (we never auto-update on a partially-trusted source).
 */
export function huggingFaceSource(args?: {
	timeoutMs?: number;
	baseUrl?: string;
}): VoiceModelCatalogSource {
	const baseUrl = args?.baseUrl ?? "https://huggingface.co";
	return {
		id: "huggingface",
		async fetchAll(
			signal: AbortSignal,
		): Promise<ReadonlyArray<VoiceModelVersion>> {
			const seenRepos = new Set<string>();
			const out: VoiceModelVersion[] = [];
			const timed = withTimeout(
				signal,
				args?.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS,
			);
			try {
				for (const v of VOICE_MODEL_VERSIONS) {
					const key = `${v.hfRepo}@${v.hfRevision}`;
					if (seenRepos.has(key)) continue;
					seenRepos.add(key);
					const url = `${baseUrl}/api/models/${v.hfRepo}/tree/${encodeURIComponent(v.hfRevision)}?recursive=true`;
					try {
						const res = await fetch(url, { signal: timed.signal });
						if (!res.ok) continue;
						const files = (await res.json()) as Array<{
							path: string;
							size?: number;
							lfs?: { sha256?: string };
						}>;
						const assets = files
							.filter((f) => f.lfs?.sha256 && f.size !== undefined)
							.map((f) => ({
								filename: f.path,
								sha256: String(f.lfs?.sha256),
								sizeBytes: Number(f.size ?? 0),
								quant: "fp16" as const,
							}));
						if (assets.length === 0) continue;
						out.push({
							...v,
							ggufAssets: assets,
						});
					} catch {
						// continue
					}
				}
				return out;
			} finally {
				timed.dispose();
			}
		},
	};
}

/** Compose a default cascade if the caller doesn't provide one. */
export function defaultVoiceModelSources(
	opts: VoiceModelUpdaterOptions,
): ReadonlyArray<VoiceModelCatalogSource> {
	const out: VoiceModelCatalogSource[] = [];
	if (opts.cloudBaseUrl && opts.publicKeys && opts.publicKeys.length > 0) {
		out.push(
			cloudCatalogSource({
				baseUrl: opts.cloudBaseUrl,
				publicKeys: opts.publicKeys,
			}),
		);
	}
	out.push(githubReleasesSource({}));
	out.push(huggingFaceSource());
	return out;
}

/**
 * Merge the local in-binary `VOICE_MODEL_VERSIONS` with the remote
 * catalog. Local entries that match `(id, version)` are replaced by the
 * remote (remote is the source of truth for shas + sizes); local entries
 * with no remote match are kept so a build can ship a strictly-newer
 * voice model that hasn't been uploaded yet.
 */
export function mergeCatalogs(
	local: ReadonlyArray<VoiceModelVersion>,
	remote: ReadonlyArray<VoiceModelVersion>,
): ReadonlyArray<VoiceModelVersion> {
	const remoteKeys = new Set(remote.map((v) => `${v.id}@${v.version}`));
	const out: VoiceModelVersion[] = [...remote];
	for (const v of local) {
		if (!remoteKeys.has(`${v.id}@${v.version}`)) {
			out.push(v);
		}
	}
	return out;
}

/** Pick the highest-semver version per id from a merged catalog. */
export function latestPerId(
	versions: ReadonlyArray<VoiceModelVersion>,
): Map<VoiceModelId, VoiceModelVersion> {
	const out = new Map<VoiceModelId, VoiceModelVersion>();
	for (const v of versions) {
		const cur = out.get(v.id);
		if (cur === undefined) {
			out.set(v.id, v);
			continue;
		}
		const cmp = compareVoiceModelSemver(v.version, cur.version);
		if (cmp !== null && cmp > 0) {
			out.set(v.id, v);
		}
	}
	return out;
}

/**
 * Resolve the cadence in ms — env override > argument > default. Returns
 * a strictly positive number. The interval governs background ticks; the
 * UI "check now" button always bypasses.
 */
export function resolveCheckIntervalMs(override?: number): number {
	const env = process.env.ELIZA_VOICE_UPDATE_INTERVAL_MS;
	if (env !== undefined) {
		const n = Number(env);
		if (Number.isFinite(n) && n > 0) return n;
	}
	if (override !== undefined && Number.isFinite(override) && override > 0) {
		return override;
	}
	return DEFAULT_CHECK_INTERVAL_MS;
}

export interface VoiceModelDownloadInputs {
	readonly version: VoiceModelVersion;
	/** Bundle voice directory where the final file lives. */
	readonly bundleVoiceDir: string;
	/** Staging directory for `.part` files. */
	readonly stagingDir: string;
	/**
	 * Index into `version.ggufAssets` selecting the asset to fetch. The
	 * caller's quant-selection policy (R8) decides which.
	 */
	readonly assetIndex: number;
	/** Network policy decision attested by the caller. */
	readonly networkPolicy: NetworkPolicyDecision;
	/** AbortSignal — required so the cancel button stops downloads. */
	readonly signal: AbortSignal;
	/** HF resolve-URL builder; defaults to standard HF resolve path. */
	readonly resolveUrl?: (
		repo: string,
		revision: string,
		file: string,
	) => string;
}

export class VoiceModelDownloadError extends Error {
	readonly code: string;
	constructor(message: string, code: string) {
		super(message);
		this.name = "VoiceModelDownloadError";
		this.code = code;
	}
}

const buildHfResolveUrl = (
	repo: string,
	revision: string,
	file: string,
): string =>
	`https://huggingface.co/${repo}/resolve/${encodeURIComponent(revision)}/${file}`;

/**
 * Atomic-swap downloader for a single voice asset.
 *
 * Refuses to proceed when `networkPolicy.allow === false` so headless
 * environments and pre-OWNER cellular skip cleanly. Streams to a
 * `<id>-<version>.<filename>.part` file in the staging dir, hashes,
 * verifies against the catalog sha256, then renames into the bundle voice
 * dir using a `<id>-<version>.<filename>` final name so old + new
 * versions coexist briefly during the swap (R5 §6.2).
 */
export async function downloadVoiceModel(
	args: VoiceModelDownloadInputs,
): Promise<{ finalPath: string; sha256: string; sizeBytes: number }> {
	if (!args.networkPolicy.allow) {
		throw new VoiceModelDownloadError(
			`network policy refused download (reason=${args.networkPolicy.reason})`,
			"ELIZA_VOICE_NET_POLICY_REFUSED",
		);
	}
	const asset = args.version.ggufAssets[args.assetIndex];
	if (!asset) {
		throw new VoiceModelDownloadError(
			`asset index ${args.assetIndex} out of range (have ${args.version.ggufAssets.length})`,
			"ELIZA_VOICE_ASSET_INDEX",
		);
	}
	await fsp.mkdir(args.stagingDir, { recursive: true });
	await fsp.mkdir(args.bundleVoiceDir, { recursive: true });
	const stageName = `${args.version.id}-${args.version.version}-${path.basename(asset.filename)}.part`;
	const stagePath = path.join(args.stagingDir, stageName);
	const finalName = `${args.version.id}-${args.version.version}-${path.basename(asset.filename)}`;
	const finalPath = path.join(args.bundleVoiceDir, finalName);

	const resolveUrl = args.resolveUrl ?? buildHfResolveUrl;
	const url = resolveUrl(
		args.version.hfRepo,
		args.version.hfRevision,
		asset.filename,
	);
	const res = await fetch(url, { signal: args.signal });
	if (!res.ok) {
		throw new VoiceModelDownloadError(
			`HTTP ${res.status} fetching ${url}`,
			"ELIZA_VOICE_HTTP",
		);
	}
	const body = res.body;
	if (!body) {
		throw new VoiceModelDownloadError(
			`empty response body for ${url}`,
			"ELIZA_VOICE_EMPTY_BODY",
		);
	}

	// Materialise the streamed bytes into the staging file. We re-implement
	// the small piece of streaming we need rather than pulling in the full
	// downloader.ts here, because that module is tied to the catalog and
	// bundle layer.
	const buffer = new Uint8Array(await new Response(body).arrayBuffer());
	await fsp.writeFile(stagePath, buffer);

	const computed = await hashFile(stagePath);
	if (computed !== asset.sha256) {
		await fsp.rm(stagePath, { force: true });
		throw new VoiceModelDownloadError(
			`sha256 mismatch for ${asset.filename}: expected ${asset.sha256}, got ${computed}`,
			"ELIZA_VOICE_SHA_MISMATCH",
		);
	}
	const stat = await fsp.stat(stagePath);
	if (asset.sizeBytes > 0 && stat.size !== asset.sizeBytes) {
		await fsp.rm(stagePath, { force: true });
		throw new VoiceModelDownloadError(
			`size mismatch for ${asset.filename}: expected ${asset.sizeBytes}, got ${stat.size}`,
			"ELIZA_VOICE_SIZE_MISMATCH",
		);
	}
	await fsp.rename(stagePath, finalPath);
	return { finalPath, sha256: computed, sizeBytes: stat.size };
}

/**
 * Computed status for one model id. Surfaced by `VoiceModelUpdater.check`
 * and by the `/api/local-inference/voice-models/status` route.
 */
export interface VoiceModelStatus {
	readonly id: VoiceModelId;
	readonly installedVersion: string | null;
	readonly latestKnown: VoiceModelVersion | null;
	readonly pinned: boolean;
	readonly decision: ReturnType<typeof shouldAutoUpdateVoiceModel>;
}

export interface VoiceModelInstallState {
	/** `VoiceModelId` → currently-installed semver (null = not installed). */
	readonly installed: ReadonlyMap<VoiceModelId, string | null>;
	/** Bundle version this device is currently running (e.g. manifest `version`). */
	readonly bundleVersion: string;
}

export class VoiceModelUpdater {
	readonly options: VoiceModelUpdaterOptions;
	private lastCheckAt: number | null = null;
	private lastResult: ReadonlyArray<VoiceModelStatus> | null = null;
	private inFlight: Promise<ReadonlyArray<VoiceModelStatus>> | null = null;

	constructor(options: VoiceModelUpdaterOptions = {}) {
		this.options = options;
	}

	/** Sources used by this updater (defaults composed from options). */
	get sources(): ReadonlyArray<VoiceModelCatalogSource> {
		return this.options.sources ?? defaultVoiceModelSources(this.options);
	}

	/**
	 * Run a check against the cascade, merge with the local in-binary
	 * catalog, and return a per-id status.
	 *
	 * `force === false` (default) returns the cached result when the last
	 * check was within `resolveCheckIntervalMs()`. `force === true` always
	 * re-fetches.
	 */
	async check(
		install: VoiceModelInstallState,
		pinPolicy: VoiceModelPinPolicy,
		options?: { force?: boolean; signal?: AbortSignal },
	): Promise<ReadonlyArray<VoiceModelStatus>> {
		const intervalMs = resolveCheckIntervalMs();
		if (
			!options?.force &&
			this.lastResult &&
			this.lastCheckAt !== null &&
			Date.now() - this.lastCheckAt < intervalMs
		) {
			return this.lastResult;
		}
		// De-dup concurrent callers — second caller waits on the first.
		if (this.inFlight) return this.inFlight;
		this.inFlight = this.runCheck(install, pinPolicy, options?.signal);
		try {
			const result = await this.inFlight;
			this.lastResult = result;
			this.lastCheckAt = Date.now();
			return result;
		} finally {
			this.inFlight = null;
		}
	}

	private async runCheck(
		install: VoiceModelInstallState,
		pinPolicy: VoiceModelPinPolicy,
		signal: AbortSignal | undefined,
	): Promise<ReadonlyArray<VoiceModelStatus>> {
		const ctl = new AbortController();
		const detach = signal
			? signal.addEventListener("abort", () => ctl.abort(), { once: true })
			: null;
		try {
			const fetched = await fetchVoiceModelCatalog(
				this.sources,
				ctl.signal,
				this.options.logger,
			);
			const remote = fetched?.versions ?? [];
			const merged = mergeCatalogs(VOICE_MODEL_VERSIONS, remote);
			const latest = latestPerId(merged);
			const out: VoiceModelStatus[] = [];
			const ids = new Set<VoiceModelId>([
				...install.installed.keys(),
				...latest.keys(),
			]);
			for (const id of ids) {
				const installedVersion = install.installed.get(id) ?? null;
				const candidate = latest.get(id) ?? null;
				const pinned = pinPolicy.pinned.has(id);
				const decision = candidate
					? shouldAutoUpdateVoiceModel({
							installedVersion,
							candidate,
							bundleVersion: install.bundleVersion,
							pinned,
						})
					: { allow: false, reason: "up-to-date" as const };
				out.push({
					id,
					installedVersion,
					latestKnown: candidate,
					pinned,
					decision,
				});
			}
			out.sort((a, b) => a.id.localeCompare(b.id));
			return out;
		} finally {
			if (detach && signal)
				signal.removeEventListener("abort", () => ctl.abort());
		}
	}

	/** Pure helper for tests; returns the merged + per-id-latest map. */
	static computeLatestPerId(
		remote: ReadonlyArray<VoiceModelVersion>,
	): Map<VoiceModelId, VoiceModelVersion> {
		return latestPerId(mergeCatalogs(VOICE_MODEL_VERSIONS, remote));
	}
}

/**
 * Compose an AbortSignal that fires when either the caller's signal fires
 * or the timeout elapses. Returns a `dispose` function so the timer can be
 * cleared on the happy path.
 */
function withTimeout(
	signal: AbortSignal,
	timeoutMs: number,
): { signal: AbortSignal; dispose: () => void } {
	const ctl = new AbortController();
	const timer = setTimeout(() => ctl.abort(), timeoutMs);
	const onAbort = () => ctl.abort();
	signal.addEventListener("abort", onAbort, { once: true });
	return {
		signal: ctl.signal,
		dispose: () => {
			clearTimeout(timer);
			signal.removeEventListener("abort", onAbort);
		},
	};
}
