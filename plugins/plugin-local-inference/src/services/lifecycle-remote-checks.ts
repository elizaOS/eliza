/**
 * Remote (publish-side) checks for the local-model lifecycle matrix (#10727).
 *
 * These helpers probe the catalog's HuggingFace download URLs and the per-tier
 * bundle-manifest closure. They mirror the production downloader's request
 * shape (`downloader.ts`): the same user-agent and — critically — the same
 * `resolveHfDownloadBase().authHeader`, so a cloud-linked host that routes
 * downloads through the Eliza Cloud HF proxy probes with the bearer the proxy
 * requires instead of reporting false 401/404 "publish gaps".
 *
 * Transient upstream statuses (429 rate limit, 5xx) are retried and then
 * reported as `warn` (inconclusive), never `fail`: a rate-limited probe is not
 * evidence that an artifact is unpublished.
 */

import {
	buildHuggingFaceResolveUrlForPath,
	MODEL_CATALOG,
	resolveHfDownloadBase,
} from "./catalog";
import {
	type LifecycleBundleRemoteCheck,
	type LifecycleRemoteCheck,
	listLocalModelLifecycleArtifacts,
} from "./local-model-lifecycle-matrix";
import type { CatalogModel } from "./types";

export interface LifecycleRemoteCheckOptions {
	timeoutMs?: number;
	/** Injectable fetch for tests. Defaults to global fetch. */
	fetchImpl?: typeof fetch;
	/** Injectable sleep for tests. Defaults to setTimeout. */
	sleep?: (ms: number) => Promise<void>;
	/** Attempts for transient (429/5xx) statuses, including the first. */
	transientAttempts?: number;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_TRANSIENT_ATTEMPTS = 3;
const TRANSIENT_BACKOFF_MS = 1_000;
const MAX_RETRY_AFTER_MS = 10_000;

/**
 * Request headers for lifecycle probes — identical to the production
 * downloader's fetch shape so the matrix observes the same behavior real
 * downloads get (cloud HF-proxy bearer included when the device is linked).
 */
export function lifecycleRequestHeaders(
	base: ReturnType<typeof resolveHfDownloadBase> = resolveHfDownloadBase(),
): Record<string, string> {
	return {
		"user-agent": "Eliza-LocalInference/1.0",
		...base.authHeader,
	};
}

function defaultSleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTransientStatus(statusCode: number): boolean {
	return statusCode === 429 || statusCode >= 500;
}

function retryAfterMs(response: Response): number | null {
	const raw = response.headers.get("retry-after");
	if (!raw) return null;
	const seconds = Number(raw);
	if (!Number.isFinite(seconds) || seconds < 0) return null;
	return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
}

async function fetchWithTimeout(
	fetchImpl: typeof fetch,
	url: string,
	init: RequestInit,
	timeoutMs: number,
): Promise<Response> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), timeoutMs);
	try {
		return await fetchImpl(url, { ...init, signal: controller.signal });
	} finally {
		clearTimeout(timeout);
	}
}

/**
 * Probe one download URL. HEAD first; 405/403 fall back to a 1-byte ranged
 * GET (some hosts reject HEAD); 429/5xx retry with backoff and degrade to
 * `warn` when they persist. Only a definitive non-transient HTTP error (401,
 * 404, 410, …) is a `fail`.
 */
export async function checkLifecycleUrl(
	url: string,
	options: LifecycleRemoteCheckOptions = {},
): Promise<LifecycleRemoteCheck> {
	const fetchImpl = options.fetchImpl ?? fetch;
	const sleep = options.sleep ?? defaultSleep;
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const attempts = options.transientAttempts ?? DEFAULT_TRANSIENT_ATTEMPTS;
	const headers = lifecycleRequestHeaders();
	const checkedAt = new Date().toISOString();
	try {
		let response: Response | null = null;
		for (let attempt = 1; attempt <= attempts; attempt += 1) {
			response = await fetchWithTimeout(
				fetchImpl,
				url,
				{ method: "HEAD", redirect: "follow", headers },
				timeoutMs,
			);
			if (response.status === 405 || response.status === 403) {
				response = await fetchWithTimeout(
					fetchImpl,
					url,
					{
						method: "GET",
						redirect: "follow",
						headers: { ...headers, Range: "bytes=0-0" },
					},
					timeoutMs,
				);
			}
			if (!isTransientStatus(response.status) || attempt === attempts) break;
			await sleep(retryAfterMs(response) ?? TRANSIENT_BACKOFF_MS * attempt);
		}
		if (!response) {
			return {
				status: "warn",
				detail: "remote check ran zero attempts",
				checkedAt,
			};
		}
		if (isTransientStatus(response.status)) {
			return {
				status: "warn",
				detail:
					`inconclusive: transient HTTP ${response.status} ${response.statusText} after ${attempts} attempt(s) — not evidence of a publish gap`.trim(),
				checkedAt,
				httpStatus: response.status,
			};
		}
		const status = response.ok || response.status === 206 ? "pass" : "fail";
		return {
			status,
			detail: `HTTP ${response.status} ${response.statusText}`.trim(),
			checkedAt,
			httpStatus: response.status,
		};
	} catch (error) {
		return {
			status: "warn",
			detail: `remote check failed: ${error instanceof Error ? error.message : String(error)}`,
			checkedAt,
		};
	}
}

/** Probe every catalog-advertised artifact URL, keyed by lifecycle artifact key. */
export async function collectLifecycleRemoteChecks(
	options: LifecycleRemoteCheckOptions = {},
	catalog: ReadonlyArray<CatalogModel> = MODEL_CATALOG,
): Promise<Record<string, LifecycleRemoteCheck>> {
	const checks: Record<string, LifecycleRemoteCheck> = {};
	for (const artifact of listLocalModelLifecycleArtifacts(catalog)) {
		if (!artifact.downloadUrl) continue;
		checks[artifact.key] = await checkLifecycleUrl(
			artifact.downloadUrl,
			options,
		);
	}
	return checks;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/** Every distinct `path` referenced by a bundle manifest's `files` map. */
export function flattenManifestFilePaths(manifest: unknown): string[] {
	if (!isRecord(manifest) || !isRecord(manifest.files)) return [];
	const paths = new Set<string>();
	for (const value of Object.values(manifest.files)) {
		if (Array.isArray(value)) {
			for (const entry of value) {
				if (isRecord(entry) && typeof entry.path === "string") {
					paths.add(entry.path);
				}
			}
			continue;
		}
		if (isRecord(value) && typeof value.path === "string") {
			paths.add(value.path);
		}
	}
	return [...paths].sort();
}

/**
 * Fetch each tier's bundle manifest and probe every file it references.
 * Bundle status: `fail` only when at least one file definitively fails;
 * `warn` when the only non-passing files are inconclusive (transient).
 */
export async function collectLifecycleBundleChecks(
	options: LifecycleRemoteCheckOptions = {},
	catalog: ReadonlyArray<CatalogModel> = MODEL_CATALOG,
): Promise<Record<string, LifecycleBundleRemoteCheck>> {
	const fetchImpl = options.fetchImpl ?? fetch;
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const checks: Record<string, LifecycleBundleRemoteCheck> = {};
	for (const model of catalog) {
		if (!model.bundleManifestFile) continue;
		const manifestUrl = buildHuggingFaceResolveUrlForPath(
			model,
			model.bundleManifestFile,
		);
		const manifestCheck = await checkLifecycleUrl(manifestUrl, options);
		if (manifestCheck.status !== "pass") {
			checks[model.id] = {
				status: manifestCheck.status,
				detail: `manifest unavailable: ${manifestCheck.detail}`,
				checkedAt: manifestCheck.checkedAt,
				manifestUrl,
				fileCount: 0,
				failingFiles: [],
			};
			continue;
		}

		let manifest: unknown;
		try {
			const response = await fetchWithTimeout(
				fetchImpl,
				manifestUrl,
				{
					method: "GET",
					redirect: "follow",
					headers: lifecycleRequestHeaders(),
				},
				timeoutMs,
			);
			manifest = await response.json();
		} catch (error) {
			checks[model.id] = {
				status: "warn",
				detail: `manifest JSON parse failed: ${error instanceof Error ? error.message : String(error)}`,
				checkedAt: new Date().toISOString(),
				manifestUrl,
				fileCount: 0,
				failingFiles: [],
			};
			continue;
		}

		const filePaths = flattenManifestFilePaths(manifest);
		const failingFiles: LifecycleBundleRemoteCheck["failingFiles"] = [];
		for (const filePath of filePaths) {
			const fileUrl = buildHuggingFaceResolveUrlForPath(model, filePath);
			const fileCheck = await checkLifecycleUrl(fileUrl, options);
			if (fileCheck.status !== "pass") {
				failingFiles.push({
					path: filePath,
					status: fileCheck.status,
					detail: fileCheck.detail,
					httpStatus: fileCheck.httpStatus,
				});
			}
		}
		const hardFailures = failingFiles.filter((file) => file.status === "fail");
		checks[model.id] = {
			status:
				hardFailures.length > 0
					? "fail"
					: failingFiles.length > 0
						? "warn"
						: "pass",
			detail:
				hardFailures.length > 0
					? `${hardFailures.length}/${filePaths.length} manifest file(s) failed remote checks`
					: failingFiles.length > 0
						? `${failingFiles.length}/${filePaths.length} manifest file check(s) inconclusive (transient)`
						: `${filePaths.length} manifest file(s) passed remote checks`,
			checkedAt: new Date().toISOString(),
			manifestUrl,
			fileCount: filePaths.length,
			failingFiles,
		};
	}
	return checks;
}
