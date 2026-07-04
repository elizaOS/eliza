import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readAssignments } from "./assignments";
import { findCatalogModel } from "./catalog";
import { Downloader, GatedRepoError } from "./downloader";
import type { Eliza1DeviceCaps } from "./manifest";
import { registryPath } from "./paths";
import { listInstalledModels } from "./registry";
import type {
	CatalogModel,
	DownloadJob,
	HardwareProbe,
	InstalledModel,
} from "./types";

/** Minimal HardwareProbe with a controllable free-disk value for preflight tests. */
function fakeProbe(freeDiskGb: number): HardwareProbe {
	return {
		totalRamGb: 32,
		freeRamGb: 16,
		freeDiskGb,
		gpu: null,
		cpuCores: 8,
		platform: "darwin",
		arch: "arm64",
		appleSilicon: true,
		recommendedBucket: "mid",
		source: "os-fallback",
	};
}

function eliza1Manifest(overrides: {
	ramBudgetMin?: number;
	ramBudgetRecommended?: number;
	verifiedBackends?: Record<
		string,
		{ status: string; atCommit: string; report: string }
	>;
	shaFor: (key: string) => string;
}): string {
	const textPath = "text/eliza-1-2b-128k.gguf";
	const voicePath = "tts/voice.gguf";
	const asrPath = "asr/asr.gguf";
	const cachePath = "cache/voice-preset-default.bin";
	const vadPath = "vad/eliza-1-vad.onnx";
	const visionPath = "vision/mmproj-2b.gguf";
	const verifiedBackends = overrides.verifiedBackends ?? {
		metal: { status: "pass", atCommit: "t", report: "metal" },
		vulkan: { status: "pass", atCommit: "t", report: "vulkan" },
		cuda: { status: "pass", atCommit: "t", report: "cuda" },
		rocm: { status: "pass", atCommit: "t", report: "rocm" },
		cpu: { status: "pass", atCommit: "t", report: "cpu" },
	};
	return JSON.stringify({
		id: "eliza-1-2b",
		tier: "2b",
		version: "1.0.0",
		publishedAt: "2026-05-11T00:00:00.000Z",
		lineage: {
			text: { base: "eliza-1-text", license: "test" },
			voice: { base: "eliza-1-voice", license: "test" },
			asr: { base: "eliza-1-asr", license: "test" },
			vad: { base: "eliza-1-vad", license: "test" },
			vision: { base: "eliza-1-vision", license: "test" },
		},
		defaultEligible: true,
		// Downloader-mechanics fixture: MTP mode is incidental here, so this
		// bundle is the legacy embedded-draft-head shape (no separate drafter
		// GGUF to serve). The Gemma-4 separate-drafter contract is exercised in
		// manifest.test.ts.
		mtp: "embedded-draft-head",
		files: {
			text: [
				{
					path: textPath,
					sha256: overrides.shaFor("text"),
					ctx: 131072,
				},
			],
			voice: [{ path: voicePath, sha256: overrides.shaFor("voice") }],
			asr: [{ path: asrPath, sha256: overrides.shaFor("asr") }],
			vision: [{ path: visionPath, sha256: overrides.shaFor("vision") }],
			mtp: [],
			cache: [
				{
					path: cachePath,
					sha256: overrides.shaFor("cache"),
				},
			],
			vad: [{ path: vadPath, sha256: overrides.shaFor("vad") }],
		},
		kernels: {
			required: ["turboquant_q4", "qjl", "polarquant", "turbo3_tcq"],
			optional: [],
			verifiedBackends,
		},
		evals: {
			textEval: { score: 1, passed: true },
			voiceRtf: { rtf: 0.5, passed: true },
			asrWer: { wer: 0.05, passed: true },
			vadLatencyMs: { median: 16, passed: true },
			mtp: { acceptanceRate: 0.72, speedup: 1.8, passed: true },
			e2eLoopOk: true,
			thirtyTurnOk: true,
		},
		ramBudgetMb: {
			min: overrides.ramBudgetMin ?? 2048,
			recommended: overrides.ramBudgetRecommended ?? 4096,
		},
	});
}

const cpuOnlyCaps: Eliza1DeviceCaps = {
	availableBackends: ["cpu"],
	ramMb: 16_384,
};

function remotePathOf(url: string | URL | Request): string {
	const href =
		typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
	const pathname = new URL(href).pathname;
	const marker = "/resolve/main/";
	const idx = pathname.indexOf(marker);
	return idx >= 0
		? decodeURIComponent(pathname.slice(idx + marker.length))
		: "";
}

function bundleRemotePath(
	model: { bundleManifestFile?: string; hfPathPrefix?: string },
	rel: string,
): string {
	if (model.hfPathPrefix && !rel.startsWith(`${model.hfPathPrefix}/`)) {
		return path.posix.join(model.hfPathPrefix, rel);
	}
	if (!model.bundleManifestFile) {
		throw new Error("missing bundle manifest path");
	}
	return path.posix.join(path.posix.dirname(model.bundleManifestFile), rel);
}

function eliza1BundleRemotePath(rel: string): string {
	const model = findCatalogModel("eliza-1-2b");
	if (!model) throw new Error("missing 2b catalog model");
	return bundleRemotePath(model, rel);
}

function eliza1BundleManifestPath(): string {
	const model = findCatalogModel("eliza-1-2b");
	if (!model?.bundleManifestFile) {
		throw new Error("missing 2b bundle manifest path");
	}
	return bundleRemotePath(model, model.bundleManifestFile);
}

/** A fetch that serves only the manifest; any weight fetch throws. */
function installManifestOnlyFetch(
	manifestBody: string,
	manifestPath: string = eliza1BundleManifestPath(),
): ReturnType<typeof vi.fn> {
	const spy = vi.fn(async (url: string | URL | Request) => {
		if (remotePathOf(url) === manifestPath) {
			return new Response(manifestBody, {
				status: 200,
				headers: { "content-length": String(Buffer.byteLength(manifestBody)) },
			});
		}
		throw new Error(`unexpected weight fetch for ${remotePathOf(url)}`);
	});
	globalThis.fetch = spy as unknown as typeof fetch;
	return spy;
}

const originalEnv = { ...process.env };
const originalFetch = globalThis.fetch;

afterEach(() => {
	process.env = { ...originalEnv };
	globalThis.fetch = originalFetch;
	vi.restoreAllMocks();
});

function sha256(content: string): string {
	return createHash("sha256").update(content).digest("hex");
}

function readOwnedRegistryModels(): InstalledModel[] {
	if (!fs.existsSync(registryPath())) return [];
	const parsed = JSON.parse(fs.readFileSync(registryPath(), "utf8")) as {
		models?: InstalledModel[];
	};
	return parsed.models ?? [];
}

function installFetchFixture(files: Map<string, string>): void {
	globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
		const href =
			typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
		const pathname = new URL(href).pathname;
		const marker = "/resolve/main/";
		const markerIndex = pathname.indexOf(marker);
		const remotePath =
			markerIndex >= 0
				? decodeURIComponent(pathname.slice(markerIndex + marker.length))
				: "";
		const body = files.get(remotePath);
		if (body === undefined) {
			return new Response(`missing ${remotePath}`, { status: 404 });
		}
		return new Response(body, {
			status: 200,
			headers: { "content-length": String(Buffer.byteLength(body)) },
		});
	}) as unknown as typeof fetch;
}

/**
 * A fetch fixture that honors `Range: bytes=N-` the way the HuggingFace CDN
 * does (HTTP 206 + the current file's bytes from offset N). This is what makes
 * the stale-partial corruption reproducible: a Range resume against a
 * re-published file appends NEW-version bytes onto OLD-version bytes.
 * Returns the ranges each remote path was requested with, so tests can assert
 * resume-vs-fresh behavior.
 */
function installRangeAwareFetchFixture(files: Map<string, string>): {
	rangeRequests: Map<string, string[]>;
} {
	const rangeRequests = new Map<string, string[]>();
	globalThis.fetch = vi.fn(
		async (url: string | URL | Request, init?: RequestInit) => {
			const remotePath = remotePathOf(url);
			const body = files.get(remotePath);
			if (body === undefined) {
				return new Response(`missing ${remotePath}`, { status: 404 });
			}
			const headers = (init?.headers ?? {}) as Record<string, string>;
			const range = headers.range;
			if (range) {
				const seen = rangeRequests.get(remotePath) ?? [];
				seen.push(range);
				rangeRequests.set(remotePath, seen);
				const match = /^bytes=(\d+)-$/.exec(range);
				const start = match?.[1] ? Number.parseInt(match[1], 10) : 0;
				const buf = Buffer.from(body);
				const tail = buf.subarray(start);
				return new Response(tail, {
					status: 206,
					headers: {
						"content-length": String(tail.length),
						"content-range": `bytes ${start}-${buf.length - 1}/${buf.length}`,
					},
				});
			}
			return new Response(body, {
				status: 200,
				headers: { "content-length": String(Buffer.byteLength(body)) },
			});
		},
	) as unknown as typeof fetch;
	return { rangeRequests };
}

/** Standard 2b bundle content set for stale-content robustness tests. */
const freshBundleBytes = {
	text: "GGUF gemma4 text model (4737MB in prod, tiny here)",
	voice: "GGUF voice model",
	asr: "GGUF asr model",
	vad: "VAD onnx",
	cache: "voice preset",
	vision: "vision projector",
} as const;

function freshBundleFixtureFiles(): Map<string, string> {
	const manifest = eliza1Manifest({
		shaFor: (k) => sha256(freshBundleBytes[k as keyof typeof freshBundleBytes]),
	});
	return new Map([
		[eliza1BundleManifestPath(), manifest],
		[
			eliza1BundleRemotePath("text/eliza-1-2b-128k.gguf"),
			freshBundleBytes.text,
		],
		[eliza1BundleRemotePath("tts/voice.gguf"), freshBundleBytes.voice],
		[eliza1BundleRemotePath("asr/asr.gguf"), freshBundleBytes.asr],
		[eliza1BundleRemotePath("vad/eliza-1-vad.onnx"), freshBundleBytes.vad],
		[
			eliza1BundleRemotePath("cache/voice-preset-default.bin"),
			freshBundleBytes.cache,
		],
		[eliza1BundleRemotePath("vision/mmproj-2b.gguf"), freshBundleBytes.vision],
	]);
}

/** Staging `.part` path the downloader derives for a 2b bundle file. */
function eliza1StagingPartPath(root: string, filePath: string): string {
	const safe = `eliza-1-2b__${filePath}`.replace(/[^a-zA-Z0-9._-]/g, "_");
	return path.join(root, "local-inference", "downloads", `${safe}.part`);
}

function eliza1BundleFinalPath(root: string, filePath: string): string {
	return path.join(
		root,
		"local-inference",
		"models",
		"eliza-1-2b.bundle",
		filePath,
	);
}

function waitForTerminal(
	downloader: Downloader,
	modelId: string,
): Promise<DownloadJob> {
	return new Promise((resolve, reject) => {
		const unsubscribe = downloader.subscribe((event) => {
			if (event.job.modelId !== modelId) return;
			if (event.type === "completed") {
				unsubscribe();
				resolve(event.job);
			}
			if (event.type === "failed") {
				unsubscribe();
				reject(new Error(event.job.error ?? "download failed"));
			}
		});
	});
}

describe("local inference downloader status", () => {
	it("loads persisted terminal failures into snapshots", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-download-test-"));
		process.env.ELIZA_STATE_DIR = root;
		const statusDir = path.join(root, "local-inference");
		fs.mkdirSync(statusDir, { recursive: true });
		fs.writeFileSync(
			path.join(statusDir, "download-status.json"),
			JSON.stringify({
				version: 1,
				jobs: [
					{
						jobId: "job-1",
						modelId: "eliza-1-2b",
						state: "failed",
						received: 64,
						total: 128,
						bytesPerSec: 0,
						etaMs: null,
						startedAt: "2026-05-08T00:00:00.000Z",
						updatedAt: "2026-05-08T00:00:01.000Z",
						error: "network reset",
					},
				],
			}),
			"utf8",
		);

		const [job] = new Downloader().snapshot();

		expect(job?.modelId).toBe("eliza-1-2b");
		expect(job?.state).toBe("failed");
		expect(job?.error).toBe("network reset");
	});

	it("installs Eliza-1 manifest bundles with embedded-draft-head MTP metadata", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-download-test-"));
		process.env.ELIZA_STATE_DIR = root;
		const model = findCatalogModel("eliza-1-2b");
		expect(model).toBeDefined();
		if (!model) throw new Error("missing test catalog model");
		const manifestFile = model.bundleManifestFile;
		if (!manifestFile) throw new Error("missing bundle manifest path");

		const text = "GGUF text model";
		const voice = "GGUF voice model";
		const asr = "GGUF ASR model";
		const vad = "VAD model";
		const cache = "voice preset";
		const vision = "vision projector";
		const textPath = "text/eliza-1-2b-128k.gguf";
		const voicePath = "tts/voice.gguf";
		const asrPath = "asr/asr.gguf";
		const vadPath = "vad/eliza-1-vad.onnx";
		const cachePath = "cache/voice-preset-default.bin";
		const visionPath = "vision/mmproj-2b.gguf";
		const manifest = JSON.stringify({
			id: "eliza-1-2b",
			tier: "2b",
			version: "1.0.0",
			publishedAt: "2026-05-11T00:00:00.000Z",
			lineage: {
				text: { base: "eliza-1-text", license: "test" },
				voice: { base: "eliza-1-voice", license: "test" },
				asr: { base: "eliza-1-asr", license: "test" },
				vad: { base: "eliza-1-vad", license: "test" },
				vision: { base: "eliza-1-vision", license: "test" },
			},
			defaultEligible: true,
			mtp: "embedded-draft-head",
			files: {
				text: [
					{
						path: textPath,
						sha256: sha256(text),
						ctx: 131072,
					},
				],
				voice: [{ path: voicePath, sha256: sha256(voice) }],
				asr: [{ path: asrPath, sha256: sha256(asr) }],
				vision: [{ path: visionPath, sha256: sha256(vision) }],
				mtp: [],
				cache: [
					{
						path: cachePath,
						sha256: sha256(cache),
					},
				],
				vad: [{ path: vadPath, sha256: sha256(vad) }],
			},
			kernels: {
				required: ["turboquant_q4", "qjl", "polarquant", "turbo3_tcq"],
				optional: [],
				verifiedBackends: {
					metal: {
						status: "pass",
						atCommit: "test",
						report: "test-metal",
					},
					vulkan: {
						status: "pass",
						atCommit: "test",
						report: "test-vulkan",
					},
					cuda: {
						status: "pass",
						atCommit: "test",
						report: "test-cuda",
					},
					rocm: {
						status: "pass",
						atCommit: "test",
						report: "test-rocm",
					},
					cpu: {
						status: "pass",
						atCommit: "test",
						report: "test-cpu",
					},
				},
			},
			evals: {
				textEval: { score: 1, passed: true },
				voiceRtf: { rtf: 0.5, passed: true },
				asrWer: { wer: 0.05, passed: true },
				vadLatencyMs: { median: 16, passed: true },
				mtp: { acceptanceRate: 0.72, speedup: 1.8, passed: true },
				e2eLoopOk: true,
				thirtyTurnOk: true,
			},
			ramBudgetMb: { min: 2048, recommended: 4096 },
		});
		installFetchFixture(
			new Map([
				[bundleRemotePath(model, manifestFile), manifest],
				[bundleRemotePath(model, textPath), text],
				[bundleRemotePath(model, voicePath), voice],
				[bundleRemotePath(model, asrPath), asr],
				[bundleRemotePath(model, vadPath), vad],
				[bundleRemotePath(model, cachePath), cache],
				[bundleRemotePath(model, visionPath), vision],
			]),
		);

		const downloader = new Downloader({
			probeDeviceCaps: async () => cpuOnlyCaps,
			probeHardware: async () => fakeProbe(100),
		});
		const completed = waitForTerminal(downloader, model.id);
		await downloader.start(model);
		const job = await completed;
		const installed = readOwnedRegistryModels();
		const main = installed.find((entry) => entry.id === model.id);
		expect(main).toBeDefined();
		const bundleRoot = main?.bundleRoot;
		expect(bundleRoot).toBeDefined();
		if (!main || !bundleRoot) {
			throw new Error("bundle install did not register expected files");
		}

		expect(job.state).toBe("completed");
		expect(main.path).toBe(path.join("models", "eliza-1-2b.bundle", textPath));
		expect(bundleRoot).toBe(path.join("models", "eliza-1-2b.bundle"));
		expect(main.manifestPath).toBe(path.join(bundleRoot, manifestFile));
		expect(main.bundleVersion).toBe("1.0.0");
		expect(main.bundleSizeBytes).toBeGreaterThan(main.sizeBytes);
		const hydratedMain = (await listInstalledModels()).find(
			(entry) => entry.id === model.id,
		);
		const hydratedBundleRoot = path.join(
			root,
			"local-inference",
			"models",
			"eliza-1-2b.bundle",
		);
		expect(hydratedMain?.bundleRoot).toBe(hydratedBundleRoot);
		expect(hydratedMain?.manifestPath).toBe(
			path.join(hydratedBundleRoot, manifestFile),
		);
		expect(fs.existsSync(path.join(hydratedBundleRoot, voicePath))).toBe(true);
		expect(fs.existsSync(path.join(hydratedBundleRoot, asrPath))).toBe(true);
		expect(fs.existsSync(path.join(hydratedBundleRoot, vadPath))).toBe(true);
		expect(fs.existsSync(path.join(hydratedBundleRoot, visionPath))).toBe(true);
		expect(installed.some((entry) => entry.id.endsWith("-drafter"))).toBe(
			false,
		);
		expect(main.bundleVerifiedAt).toBeUndefined();
		expect(await readAssignments()).toEqual({});
	});

	it("rejects a pinned bundle manifest sha before fetching weights", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-download-test-"));
		process.env.ELIZA_STATE_DIR = root;
		const model = findCatalogModel("eliza-1-2b");
		if (!model) throw new Error("missing test catalog model");

		const fetchSpy = installManifestOnlyFetch("tampered manifest");
		const pinnedModel = {
			...model,
			companionModelIds: [],
			bundleManifestSha256: sha256("expected manifest"),
		};
		const downloader = new Downloader({
			probeDeviceCaps: async () => cpuOnlyCaps,
			probeHardware: async () => fakeProbe(100),
		});
		const failed = new Promise<DownloadJob>((resolve) => {
			const unsub = downloader.subscribe((event) => {
				if (event.job.modelId === model.id && event.type === "failed") {
					unsub();
					resolve(event.job);
				}
			});
		});

		await downloader.start(pinnedModel);
		const job = await failed;

		expect(job.error).toContain(
			`SHA256 mismatch for bundle file ${model.bundleManifestFile}`,
		);
		// The sha gate re-fetches once (bounded) to rule out a transient/stale
		// CDN edge before failing. Both calls are manifest fetches — no weight
		// byte is ever requested.
		expect(fetchSpy).toHaveBeenCalledTimes(2);
		for (const [u] of fetchSpy.mock.calls) {
			expect(remotePathOf(u as string | URL | Request)).toBe(
				eliza1BundleManifestPath(),
			);
		}
	});

	it("rejects custom CatalogModel specs before starting a download", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-download-test-"));
		process.env.ELIZA_STATE_DIR = root;
		const baseModel = findCatalogModel("eliza-1-2b");
		if (!baseModel) throw new Error("missing test catalog model");
		const customSpec: CatalogModel = {
			...baseModel,
			id: "hf:test/partial::model.gguf",
			displayName: "Partial Test Model",
			ggufFile: "model.gguf",
			bundleManifestFile: undefined,
			bundleManifestSha256: undefined,
			companionModelIds: [],
			runtimeRole: undefined,
		};

		const downloader = new Downloader();
		await expect(downloader.start(customSpec)).rejects.toThrow(
			/Custom model downloads are disabled/i,
		);

		expect(fs.existsSync(registryPath())).toBe(false);
		expect(downloader.snapshot()).toEqual([]);
	});

	it("aborts before any weight byte when no verified backend overlaps the device", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-download-test-"));
		process.env.ELIZA_STATE_DIR = root;
		// Simulate a CUDA-only bundle that a CPU-only host cannot run. Build the
		// test object from a visible catalog entry while restricting verifiedBackends
		// to CUDA only so the CPU-only host probe triggers the backend-mismatch path.
		const baseModel = findCatalogModel("eliza-1-4b");
		if (!baseModel) throw new Error("missing test catalog model");
		const model = {
			...baseModel,
			id: "eliza-1-27b-256k",
			hfPathPrefix: "bundles/27b-256k",
			ggufFile: "text/eliza-1-27b-256k-256k.gguf",
			bundleManifestFile: "eliza-1.manifest.json",
			companionModelIds: [],
		};
		const manifestFile = model.bundleManifestFile;
		if (!manifestFile) throw new Error("missing bundle manifest path");

		const textPath = model.ggufFile;
		const voicePath = "tts/voice.gguf";
		const cachePath = "cache/voice-preset-default.bin";
		const visionPath = "vision/mmproj-27b-256k.gguf";
		const manifest = JSON.stringify({
			id: "eliza-1-27b-256k",
			tier: "27b-256k",
			version: "1.0.0",
			publishedAt: "2026-05-11T00:00:00.000Z",
			lineage: {
				text: { base: "eliza-1-text", license: "test" },
				voice: { base: "eliza-1-voice", license: "test" },
				vision: { base: "eliza-1-vision", license: "test" },
			},
			defaultEligible: false,
			files: {
				text: [
					{
						path: textPath,
						sha256: sha256("x"),
						ctx: 1_048_576,
					},
				],
				voice: [{ path: voicePath, sha256: sha256("v") }],
				asr: [],
				vision: [{ path: visionPath, sha256: sha256("vision") }],
				mtp: [],
				cache: [{ path: cachePath, sha256: sha256("c") }],
			},
			kernels: {
				required: ["turboquant_q4", "qjl", "polarquant", "turbo3_tcq"],
				optional: [],
				verifiedBackends: {
					metal: { status: "skipped", atCommit: "t", report: "n/a" },
					vulkan: { status: "skipped", atCommit: "t", report: "n/a" },
					cuda: { status: "pass", atCommit: "t", report: "cuda" },
					rocm: { status: "skipped", atCommit: "t", report: "n/a" },
					cpu: { status: "skipped", atCommit: "t", report: "n/a" },
				},
			},
			evals: {
				textEval: { score: 1, passed: true },
				voiceRtf: { rtf: 0.5, passed: true },
				e2eLoopOk: true,
				thirtyTurnOk: true,
			},
			ramBudgetMb: { min: 8_000, recommended: 12_000 },
		});
		const fetchSpy = installManifestOnlyFetch(
			manifest,
			bundleRemotePath(model, manifestFile),
		);

		const downloader = new Downloader({
			probeDeviceCaps: async () => cpuOnlyCaps,
			probeHardware: async () => fakeProbe(100),
		});
		const failed = new Promise<DownloadJob>((resolve) => {
			const unsub = downloader.subscribe((event) => {
				if (event.job.modelId === model.id && event.type === "failed") {
					unsub();
					resolve(event.job);
				}
			});
		});
		await downloader.start(model);
		const job = await failed;
		expect(job.state).toBe("failed");
		expect(job.error).toMatch(/kernels\.verifiedBackends/i);
		// Manifest is fetched (it's metadata, not a weight); nothing else is.
		const weightFetches = fetchSpy.mock.calls.filter(
			([u]) => remotePathOf(u) !== bundleRemotePath(model, manifestFile),
		);
		expect(weightFetches).toHaveLength(0);
		expect(readOwnedRegistryModels().some((m) => m.id === model.id)).toBe(
			false,
		);
	});

	it("aborts before any weight byte when the RAM budget exceeds the device", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-download-test-"));
		process.env.ELIZA_STATE_DIR = root;
		const model = findCatalogModel("eliza-1-2b");
		if (!model) throw new Error("missing test catalog model");

		const manifest = eliza1Manifest({
			shaFor: () => sha256("x"),
			ramBudgetMin: 999_999,
			ramBudgetRecommended: 999_999,
		});
		installManifestOnlyFetch(manifest);

		const downloader = new Downloader({
			probeDeviceCaps: async () => cpuOnlyCaps,
			probeHardware: async () => fakeProbe(100),
		});
		const failed = new Promise<DownloadJob>((resolve) => {
			const unsub = downloader.subscribe((event) => {
				if (event.job.modelId === model.id && event.type === "failed") {
					unsub();
					resolve(event.job);
				}
			});
		});
		await downloader.start(model.id);
		const job = await failed;
		expect(job.error).toMatch(/needs at least 999999 MB RAM/);
		expect(readOwnedRegistryModels().some((m) => m.id === model.id)).toBe(
			false,
		);
	});

	it("runs the verify-on-device hook before the bundle fills a default slot", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-download-test-"));
		process.env.ELIZA_STATE_DIR = root;
		const model = findCatalogModel("eliza-1-2b");
		if (!model) throw new Error("missing test catalog model");

		const bytes = {
			text: "GGUF text",
			voice: "GGUF voice",
			asr: "GGUF asr",
			vad: "VAD onnx",
			cache: "voice preset",
			vision: "vision projector",
		} as const;
		const manifest = eliza1Manifest({
			shaFor: (k) => sha256(bytes[k as keyof typeof bytes]),
		});
		installFetchFixture(
			new Map([
				[eliza1BundleManifestPath(), manifest],
				[eliza1BundleRemotePath("text/eliza-1-2b-128k.gguf"), bytes.text],
				[eliza1BundleRemotePath("tts/voice.gguf"), bytes.voice],
				[eliza1BundleRemotePath("asr/asr.gguf"), bytes.asr],
				[eliza1BundleRemotePath("vad/eliza-1-vad.onnx"), bytes.vad],
				[eliza1BundleRemotePath("cache/voice-preset-default.bin"), bytes.cache],
				[eliza1BundleRemotePath("vision/mmproj-2b.gguf"), bytes.vision],
			]),
		);

		const verifyCalls: Array<{
			modelId: string;
			bundleRoot: string;
			manifestPath: string;
			textGgufPath: string;
		}> = [];
		const downloader = new Downloader({
			probeDeviceCaps: async () => cpuOnlyCaps,
			probeHardware: async () => fakeProbe(100),
			verifyOnDevice: async ({
				modelId,
				bundleRoot,
				manifestPath,
				textGgufPath,
			}) => {
				if (!modelId) throw new Error("verify hook missing modelId");
				verifyCalls.push({ modelId, bundleRoot, manifestPath, textGgufPath });
			},
		});
		const completed = waitForTerminal(downloader, model.id);
		await downloader.start(model.id);
		await completed;

		expect(verifyCalls).toHaveLength(1);
		expect(verifyCalls[0]?.modelId).toBe(model.id);
		expect(
			path
				.normalize(verifyCalls[0]?.textGgufPath ?? "")
				.endsWith(path.normalize("text/eliza-1-2b-128k.gguf")),
		).toBe(true);
		const installed = readOwnedRegistryModels();
		const main = installed.find((m) => m.id === model.id);
		expect(main?.bundleVerifiedAt).toBeTruthy();
		expect(main?.bundleRoot).toBe("models/eliza-1-2b.bundle");
		const hydratedMain = (await listInstalledModels()).find(
			(entry) => entry.id === model.id,
		);
		expect(verifyCalls[0]?.bundleRoot).toBe(hydratedMain?.bundleRoot);
		expect(verifyCalls[0]?.manifestPath).toBe(hydratedMain?.manifestPath);
	});

	it("fails the download (no install) when the verify-on-device hook rejects", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-download-test-"));
		process.env.ELIZA_STATE_DIR = root;
		const model = findCatalogModel("eliza-1-2b");
		if (!model) throw new Error("missing test catalog model");

		const bytes = {
			text: "GGUF text",
			voice: "GGUF voice",
			asr: "GGUF asr",
			vad: "VAD onnx",
			cache: "voice preset",
			vision: "vision projector",
		} as const;
		const manifest = eliza1Manifest({
			shaFor: (k) => sha256(bytes[k as keyof typeof bytes]),
		});
		installFetchFixture(
			new Map([
				[eliza1BundleManifestPath(), manifest],
				[eliza1BundleRemotePath("text/eliza-1-2b-128k.gguf"), bytes.text],
				[eliza1BundleRemotePath("tts/voice.gguf"), bytes.voice],
				[eliza1BundleRemotePath("asr/asr.gguf"), bytes.asr],
				[eliza1BundleRemotePath("vad/eliza-1-vad.onnx"), bytes.vad],
				[eliza1BundleRemotePath("cache/voice-preset-default.bin"), bytes.cache],
				[eliza1BundleRemotePath("vision/mmproj-2b.gguf"), bytes.vision],
			]),
		);

		const downloader = new Downloader({
			probeDeviceCaps: async () => cpuOnlyCaps,
			probeHardware: async () => fakeProbe(100),
			verifyOnDevice: async () => {
				throw new Error("barge-in cancel test failed");
			},
		});
		const failed = new Promise<DownloadJob>((resolve) => {
			const unsub = downloader.subscribe((event) => {
				if (event.job.modelId === model.id && event.type === "failed") {
					unsub();
					resolve(event.job);
				}
			});
		});
		await downloader.start(model.id);
		const job = await failed;
		expect(job.error).toMatch(/barge-in cancel test failed/);
		expect(readOwnedRegistryModels().some((m) => m.id === model.id)).toBe(
			false,
		);
	});

	it("dedups concurrent start(sameId) onto one job (no .part write race)", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-download-test-"));
		process.env.ELIZA_STATE_DIR = root;
		const model = findCatalogModel("eliza-1-2b");
		if (!model) throw new Error("missing test catalog model");

		const downloader = new Downloader({
			probeDeviceCaps: async () => cpuOnlyCaps,
		});
		// Fire two starts for the same id concurrently. The first reserves the
		// active slot synchronously before its first await, so the second sees it
		// and returns the SAME job instead of racing a second write onto the .part.
		const [a, b] = await Promise.all([
			downloader.start(model.id),
			downloader.start(model.id),
		]);
		expect(a.jobId).toBe(b.jobId);
		expect(
			downloader.snapshot().filter((j) => j.modelId === model.id),
		).toHaveLength(1);
		downloader.cancel(model.id);
	});

	it("rejects a non-GGUF (HTML) body on the single-file path", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-download-test-"));
		process.env.ELIZA_STATE_DIR = root;
		const base = findCatalogModel("eliza-1-2b");
		if (!base) throw new Error("missing test catalog model");
		// Decorate a default-eligible id as a single-file (non-bundle) download so
		// it routes through runJob's single-file path.
		const singleFileSpec: CatalogModel = {
			...base,
			hfRepo: "test/single-file",
			ggufFile: "model.gguf",
			sizeGb: 0.000001,
			bundleManifestFile: undefined,
			bundleManifestSha256: undefined,
			companionModelIds: [],
			runtimeRole: undefined,
		};

		// A gated repo can answer HTTP 200 with an HTML login page.
		globalThis.fetch = vi.fn(
			async () =>
				new Response("<html><body>Sign in to HuggingFace</body></html>", {
					status: 200,
					headers: { "content-type": "text/html" },
				}),
		) as unknown as typeof fetch;

		const downloader = new Downloader({
			probeDeviceCaps: async () => cpuOnlyCaps,
			probeHardware: async () => fakeProbe(100),
		});
		const failed = new Promise<DownloadJob>((resolve) => {
			const unsub = downloader.subscribe((event) => {
				if (event.job.modelId === base.id && event.type === "failed") {
					unsub();
					resolve(event.job);
				}
			});
		});

		await downloader.start(singleFileSpec);
		const job = await failed;

		expect(job.error).toContain("not a valid GGUF");
		// The HTML body must never be registered or left on disk as a model.
		const finalPath = path.join(
			root,
			"local-inference",
			"models",
			"eliza-1-2b.gguf",
		);
		// (registry path lives elsewhere; the rejected file is removed regardless)
		expect(fs.existsSync(finalPath)).toBe(false);
	});

	it("retries a transient 429 with backoff and completes (C8)", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-download-test-"));
		process.env.ELIZA_STATE_DIR = root;
		const base = findCatalogModel("eliza-1-2b");
		if (!base) throw new Error("missing test catalog model");
		const singleFileSpec: CatalogModel = {
			...base,
			hfRepo: "test/single-file",
			ggufFile: "model.gguf",
			sizeGb: 0.000001,
			bundleManifestFile: undefined,
			bundleManifestSha256: undefined,
			companionModelIds: [],
			runtimeRole: undefined,
		};

		const ggufBody = Buffer.concat([Buffer.from("GGUF"), Buffer.alloc(60, 0)]);
		// 429 twice, then 200 — a rate-limited artifact still exists.
		let attempts = 0;
		const fetchSpy = vi.fn(async () => {
			attempts += 1;
			if (attempts <= 2) {
				return new Response("rate limited", {
					status: 429,
					headers: { "retry-after": "0" },
				});
			}
			return new Response(ggufBody, {
				status: 200,
				headers: { "content-length": String(ggufBody.length) },
			});
		});
		globalThis.fetch = fetchSpy as unknown as typeof fetch;

		const sleeps: number[] = [];
		const downloader = new Downloader({
			probeDeviceCaps: async () => cpuOnlyCaps,
			probeHardware: async () => fakeProbe(100),
			// Deterministic, instant backoff — record the calls to bound the retry.
			sleep: async (ms) => {
				sleeps.push(ms);
			},
		});
		const completed = new Promise<DownloadJob>((resolve) => {
			const unsub = downloader.subscribe((event) => {
				if (event.job.modelId === base.id && event.type === "completed") {
					unsub();
					resolve(event.job);
				}
			});
		});

		await downloader.start(singleFileSpec);
		const job = await completed;

		expect(job.state).toBe("completed");
		// Exactly two transient retries preceded the successful third fetch —
		// the retry count is bounded, not unbounded.
		expect(attempts).toBe(3);
		expect(sleeps).toHaveLength(2);
	});

	it("throws a typed GatedRepoError on a 403 gated repo (C9)", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-download-test-"));
		process.env.ELIZA_STATE_DIR = root;
		const base = findCatalogModel("eliza-1-2b");
		if (!base) throw new Error("missing test catalog model");
		const singleFileSpec: CatalogModel = {
			...base,
			hfRepo: "test/single-file",
			ggufFile: "model.gguf",
			sizeGb: 0.000001,
			bundleManifestFile: undefined,
			bundleManifestSha256: undefined,
			companionModelIds: [],
			runtimeRole: undefined,
		};

		// A gated repo answers 403 with an HF-shaped JSON error body.
		globalThis.fetch = vi.fn(
			async () =>
				new Response(
					JSON.stringify({ error: "Access to this repo is gated." }),
					{ status: 403, headers: { "content-type": "application/json" } },
				),
		) as unknown as typeof fetch;

		const downloaderErr = new Downloader({
			probeDeviceCaps: async () => cpuOnlyCaps,
			probeHardware: async () => fakeProbe(100),
		});
		// Capture the whole failed DownloadJob at the CONSUMER boundary (the
		// emitted event / status snapshot the UI reads) — not just at the throw
		// site. C9 is only real if the structured code survives to here.
		const failedJob = new Promise<DownloadJob>((resolve) => {
			const unsub = downloaderErr.subscribe((event) => {
				if (event.job.modelId === base.id && event.type === "failed") {
					unsub();
					resolve(event.job);
				}
			});
		});

		// GatedRepoError carries the machine-readable code + HTTP status.
		const gated = new GatedRepoError("probe", 403);
		expect(gated.code).toBe("HF_GATED_REPO");
		expect(gated.httpStatus).toBe(403);

		await downloaderErr.start(singleFileSpec);
		const job = await failedJob;
		// The typed code reaches the consumer as a structured field, not just as
		// a stringified message the UI would have to pattern-match.
		expect(job.errorCode).toBe("HF_GATED_REPO");
		expect(job.errorHttpStatus).toBe(403);
		expect(job.error).toContain("gated or private");
		expect(job.error).toContain("403");

		// And it survives the terminal-status persistence round-trip: a fresh
		// Downloader reading the on-disk status still exposes the coded failure.
		const rehydrated = new Downloader({
			probeDeviceCaps: async () => cpuOnlyCaps,
		})
			.snapshot()
			.find((j) => j.modelId === base.id);
		expect(rehydrated?.errorCode).toBe("HF_GATED_REPO");
		expect(rehydrated?.errorHttpStatus).toBe(403);
	});

	it("forwards the Eliza Cloud bearer on a single-file download when cloud-linked", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-download-test-"));
		process.env.ELIZA_STATE_DIR = root;
		// The product never holds a local HF token. When cloud-linked, all HF
		// resolve traffic is routed through the cloud HF proxy and authenticated
		// with the Eliza Cloud API key (the proxy attaches the cloud-side HF_TOKEN).
		const savedKey = process.env.ELIZAOS_CLOUD_API_KEY;
		process.env.ELIZAOS_CLOUD_API_KEY = "secret-token";

		const base = findCatalogModel("eliza-1-2b");
		if (!base) throw new Error("missing test catalog model");
		const singleFileSpec: CatalogModel = {
			...base,
			hfRepo: "test/single-file",
			ggufFile: "model.gguf",
			sizeGb: 0.000001,
			bundleManifestFile: undefined,
			bundleManifestSha256: undefined,
			companionModelIds: [],
			runtimeRole: undefined,
		};

		const ggufBody = Buffer.concat([Buffer.from("GGUF"), Buffer.alloc(60, 0)]);
		let capturedAuth: string | undefined;
		globalThis.fetch = vi.fn(
			async (_url: string | URL | Request, init?: RequestInit) => {
				const headers = (init?.headers ?? {}) as Record<string, string>;
				capturedAuth = headers.authorization;
				return new Response(ggufBody, {
					status: 200,
					headers: { "content-length": String(ggufBody.length) },
				});
			},
		) as unknown as typeof fetch;

		const downloader = new Downloader({
			probeDeviceCaps: async () => cpuOnlyCaps,
			probeHardware: async () => fakeProbe(100),
		});
		const completed = new Promise<DownloadJob>((resolve) => {
			const unsub = downloader.subscribe((event) => {
				if (event.job.modelId === base.id && event.type === "completed") {
					unsub();
					resolve(event.job);
				}
			});
		});

		try {
			await downloader.start(singleFileSpec);
			await completed;
			expect(capturedAuth).toBe("Bearer secret-token");
		} finally {
			if (savedKey === undefined) delete process.env.ELIZAOS_CLOUD_API_KEY;
			else process.env.ELIZAOS_CLOUD_API_KEY = savedKey;
		}
	});

	it("blocks a download that does not fit on the models volume", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-download-test-"));
		process.env.ELIZA_STATE_DIR = root;
		const model = findCatalogModel("eliza-1-2b");
		if (!model) throw new Error("missing test catalog model");

		// Fetch must never be called: the preflight fails before any byte.
		const fetchSpy = vi.fn(async () => {
			throw new Error("network must not be touched when disk is full");
		});
		globalThis.fetch = fetchSpy as unknown as typeof fetch;

		const downloader = new Downloader({
			probeDeviceCaps: async () => cpuOnlyCaps,
			probeHardware: async () => fakeProbe(0.05),
		});
		const failed = new Promise<DownloadJob>((resolve) => {
			const unsub = downloader.subscribe((event) => {
				if (event.job.modelId === model.id && event.type === "failed") {
					unsub();
					resolve(event.job);
				}
			});
		});

		await downloader.start(model.id);
		const job = await failed;

		expect(job.error).toContain("Not enough disk space");
		expect(fetchSpy).not.toHaveBeenCalled();
	});
});

/**
 * Hub re-publish robustness: HuggingFace re-uploads bundle files under STABLE
 * filenames (the real incident: `bundles/2b/text/eliza-1-2b-128k.gguf` went
 * from qwen35 1211MB to gemma4 4737MB). A device holding the old bytes — as a
 * completed install or an interrupted `.part` — must detect the mismatch
 * against the freshly fetched manifest and re-pull cleanly, never resume the
 * stale bytes into corruption or silently keep them.
 *
 * These tests drive the REAL Downloader end to end (staging, Range resume,
 * rename, hashFile, registry); only the network edge is a fixture, and it
 * honors Range requests exactly like the HF CDN so the corruption path is
 * actually reachable.
 */
describe("local inference downloader stale-content robustness", () => {
	it("re-downloads a completed bundle file whose hub content changed under the same filename", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-download-test-"));
		process.env.ELIZA_STATE_DIR = root;
		const model = findCatalogModel("eliza-1-2b");
		if (!model) throw new Error("missing test catalog model");
		installFetchFixture(freshBundleFixtureFiles());

		// The incident: a previous install left the OLD model at the SAME final
		// path inside the bundle root, and the registry considers it installed.
		const textFinal = eliza1BundleFinalPath(root, "text/eliza-1-2b-128k.gguf");
		fs.mkdirSync(path.dirname(textFinal), { recursive: true });
		fs.writeFileSync(
			textFinal,
			"GGUF qwen35 stale text model (1211MB in prod)",
		);

		const downloader = new Downloader({
			probeDeviceCaps: async () => cpuOnlyCaps,
		});
		const completed = waitForTerminal(downloader, model.id);
		await downloader.start(model.id);
		const job = await completed;

		expect(job.state).toBe("completed");
		// The stale blob was replaced by the current content, byte for byte.
		expect(fs.readFileSync(textFinal, "utf8")).toBe(freshBundleBytes.text);
		const main = readOwnedRegistryModels().find((m) => m.id === model.id);
		expect(main?.sha256).toBe(sha256(freshBundleBytes.text));
	});

	it("discards a stale .part instead of range-resuming it into a corrupt blob", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-download-test-"));
		process.env.ELIZA_STATE_DIR = root;
		const model = findCatalogModel("eliza-1-2b");
		if (!model) throw new Error("missing test catalog model");
		const { rangeRequests } = installRangeAwareFetchFixture(
			freshBundleFixtureFiles(),
		);

		// Two stale-partial provenances, both from the OLD content version:
		// - text: `.part` stamped with the OLD content's sha (a download of the
		//   qwen35 file was interrupted, then the hub re-published gemma4);
		// - voice: `.part` with no sidecar at all (pre-fix partial, unknown
		//   provenance).
		// Resuming either would append new-version bytes onto old-version bytes.
		const textPart = eliza1StagingPartPath(root, "text/eliza-1-2b-128k.gguf");
		fs.mkdirSync(path.dirname(textPart), { recursive: true });
		fs.writeFileSync(textPart, "GGUF qwen35 partial");
		fs.writeFileSync(
			`${textPart}.expected`,
			sha256("GGUF qwen35 stale text model (1211MB in prod)"),
		);
		const voicePart = eliza1StagingPartPath(root, "tts/voice.gguf");
		fs.writeFileSync(voicePart, "GGUF old voice par");

		const downloader = new Downloader({
			probeDeviceCaps: async () => cpuOnlyCaps,
		});
		const completed = waitForTerminal(downloader, model.id);
		await downloader.start(model.id);
		const job = await completed;

		expect(job.state).toBe("completed");
		// Neither stale partial was resumed: no Range request went out for them.
		expect(
			rangeRequests.get(eliza1BundleRemotePath("text/eliza-1-2b-128k.gguf")),
		).toBeUndefined();
		expect(
			rangeRequests.get(eliza1BundleRemotePath("tts/voice.gguf")),
		).toBeUndefined();
		// The installed files are the current content, byte for byte.
		expect(
			fs.readFileSync(
				eliza1BundleFinalPath(root, "text/eliza-1-2b-128k.gguf"),
				"utf8",
			),
		).toBe(freshBundleBytes.text);
		expect(
			fs.readFileSync(eliza1BundleFinalPath(root, "tts/voice.gguf"), "utf8"),
		).toBe(freshBundleBytes.voice);
		const main = readOwnedRegistryModels().find((m) => m.id === model.id);
		expect(main?.sha256).toBe(sha256(freshBundleBytes.text));
		// No staging residue (part or sidecar) left behind.
		expect(fs.existsSync(textPart)).toBe(false);
		expect(fs.existsSync(`${textPart}.expected`)).toBe(false);
	});

	it("still range-resumes a valid .part recorded against the current manifest sha", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-download-test-"));
		process.env.ELIZA_STATE_DIR = root;
		const model = findCatalogModel("eliza-1-2b");
		if (!model) throw new Error("missing test catalog model");
		const { rangeRequests } = installRangeAwareFetchFixture(
			freshBundleFixtureFiles(),
		);

		// A genuine interrupted download of the CURRENT content: the partial is
		// a strict prefix and the sidecar records the current manifest sha.
		const prefixLen = 17;
		const textPart = eliza1StagingPartPath(root, "text/eliza-1-2b-128k.gguf");
		fs.mkdirSync(path.dirname(textPart), { recursive: true });
		fs.writeFileSync(textPart, freshBundleBytes.text.slice(0, prefixLen));
		fs.writeFileSync(`${textPart}.expected`, sha256(freshBundleBytes.text));

		const downloader = new Downloader({
			probeDeviceCaps: async () => cpuOnlyCaps,
		});
		const completed = waitForTerminal(downloader, model.id);
		await downloader.start(model.id);
		const job = await completed;

		expect(job.state).toBe("completed");
		// The resume path fired: one Range request from the partial's offset...
		expect(
			rangeRequests.get(eliza1BundleRemotePath("text/eliza-1-2b-128k.gguf")),
		).toEqual([`bytes=${prefixLen}-`]);
		// ...and prefix + tail joined into the exact current content.
		expect(
			fs.readFileSync(
				eliza1BundleFinalPath(root, "text/eliza-1-2b-128k.gguf"),
				"utf8",
			),
		).toBe(freshBundleBytes.text);
		const main = readOwnedRegistryModels().find((m) => m.id === model.id);
		expect(main?.sha256).toBe(sha256(freshBundleBytes.text));
	});

	it("re-fetches from scratch when a completed transfer fails the sha gate (stale edge)", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-download-test-"));
		process.env.ELIZA_STATE_DIR = root;
		const model = findCatalogModel("eliza-1-2b");
		if (!model) throw new Error("missing test catalog model");

		// First fetch of the text file serves stale bytes (e.g. a CDN edge that
		// has not seen the re-publish yet); the second serves the current bytes.
		const files = freshBundleFixtureFiles();
		const textRemote = eliza1BundleRemotePath("text/eliza-1-2b-128k.gguf");
		let textServes = 0;
		globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
			const remotePath = remotePathOf(url);
			let body = files.get(remotePath);
			if (body === undefined) {
				return new Response(`missing ${remotePath}`, { status: 404 });
			}
			if (remotePath === textRemote) {
				textServes += 1;
				if (textServes === 1) body = "GGUF qwen35 stale text model";
			}
			return new Response(body, {
				status: 200,
				headers: { "content-length": String(Buffer.byteLength(body)) },
			});
		}) as unknown as typeof fetch;

		const downloader = new Downloader({
			probeDeviceCaps: async () => cpuOnlyCaps,
		});
		const completed = waitForTerminal(downloader, model.id);
		await downloader.start(model.id);
		const job = await completed;

		expect(job.state).toBe("completed");
		expect(textServes).toBe(2);
		expect(
			fs.readFileSync(
				eliza1BundleFinalPath(root, "text/eliza-1-2b-128k.gguf"),
				"utf8",
			),
		).toBe(freshBundleBytes.text);
		const main = readOwnedRegistryModels().find((m) => m.id === model.id);
		expect(main?.sha256).toBe(sha256(freshBundleBytes.text));
	});

	it("fails after bounded re-fetches and leaves no wrong-content file on disk", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-download-test-"));
		process.env.ELIZA_STATE_DIR = root;
		const model = findCatalogModel("eliza-1-2b");
		if (!model) throw new Error("missing test catalog model");

		// The hub persistently serves bytes that do not match the manifest sha
		// (manifest and weights out of sync). Every attempt must be discarded.
		const files = freshBundleFixtureFiles();
		const textRemote = eliza1BundleRemotePath("text/eliza-1-2b-128k.gguf");
		files.set(textRemote, "GGUF qwen35 stale text model");

		installFetchFixture(files);

		const downloader = new Downloader({
			probeDeviceCaps: async () => cpuOnlyCaps,
		});
		const failed = new Promise<DownloadJob>((resolve) => {
			const unsub = downloader.subscribe((event) => {
				if (event.job.modelId === model.id && event.type === "failed") {
					unsub();
					resolve(event.job);
				}
			});
		});
		await downloader.start(model.id);
		const job = await failed;

		expect(job.error).toMatch(
			/SHA256 mismatch for bundle file text\/eliza-1-2b-128k\.gguf after 2 attempts/,
		);
		// The wrong bytes never survive under the final name, nothing is
		// registered, and no staging residue remains.
		const textFinal = eliza1BundleFinalPath(root, "text/eliza-1-2b-128k.gguf");
		expect(fs.existsSync(textFinal)).toBe(false);
		expect(readOwnedRegistryModels().some((m) => m.id === model.id)).toBe(
			false,
		);
		const textPart = eliza1StagingPartPath(root, "text/eliza-1-2b-128k.gguf");
		expect(fs.existsSync(textPart)).toBe(false);
		expect(fs.existsSync(`${textPart}.expected`)).toBe(false);
	});
});

describe("local inference downloader keep-awake (idle-timer) wiring (#11841)", () => {
	type KeepAwakeGlobal = {
		__ELIZA_BRIDGE__?: { keep_awake_set?: (on: boolean) => unknown };
	};

	/**
	 * Stand in for the native `keep_awake_set` bridge the iOS/Android runtime
	 * installs on `globalThis.__ELIZA_BRIDGE__`. Records every acquire/release
	 * edge and restores whatever bridge (usually none, in node) was there before.
	 */
	function installKeepAwakeSpy(impl?: (on: boolean) => void): {
		calls: boolean[];
		restore: () => void;
	} {
		const calls: boolean[] = [];
		const g = globalThis as KeepAwakeGlobal;
		const hadBridge = "__ELIZA_BRIDGE__" in g;
		const priorBridge = g.__ELIZA_BRIDGE__;
		g.__ELIZA_BRIDGE__ = {
			...(priorBridge ?? {}),
			keep_awake_set: (on: boolean) => {
				calls.push(on);
				impl?.(on);
			},
		};
		return {
			calls,
			restore: () => {
				if (hadBridge) g.__ELIZA_BRIDGE__ = priorBridge;
				else delete g.__ELIZA_BRIDGE__;
			},
		};
	}

	/**
	 * `start()` fires `runJob` background (`void this.runJob(...)`) and the job
	 * emits its terminal (`completed`/`failed`) event from inside its own body —
	 * the keep-awake release runs one tick later in the `finally`. Wait
	 * (bounded) for every acquire to be matched by a release before asserting.
	 */
	async function settleReleases(calls: boolean[]): Promise<void> {
		for (let i = 0; i < 200; i++) {
			const acquires = calls.filter((on) => on).length;
			const releases = calls.filter((on) => !on).length;
			if (acquires > 0 && acquires === releases) return;
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
	}

	it("holds the screen awake for the transfer and releases it once the job completes", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-download-test-"));
		process.env.ELIZA_STATE_DIR = root;
		const model = findCatalogModel("eliza-1-2b");
		if (!model) throw new Error("missing test catalog model");
		installFetchFixture(freshBundleFixtureFiles());
		const spy = installKeepAwakeSpy();
		try {
			const downloader = new Downloader({
				probeDeviceCaps: async () => cpuOnlyCaps,
			});
			const completed = waitForTerminal(downloader, model.id);
			await downloader.start(model.id);
			const job = await completed;
			await settleReleases(spy.calls);

			expect(job.state).toBe("completed");
			// The idle timer was disabled for the transfer and re-enabled after.
			expect(spy.calls).toContain(true);
			expect(spy.calls.at(-1)).toBe(false);
			// Every acquire is matched by a release — the finally never leaks a hold.
			const acquires = spy.calls.filter((on) => on).length;
			const releases = spy.calls.filter((on) => !on).length;
			expect(acquires).toBe(releases);
		} finally {
			spy.restore();
		}
	});

	it("releases the screen-awake hold even when the download fails mid-transfer", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-download-test-"));
		process.env.ELIZA_STATE_DIR = root;
		const model = findCatalogModel("eliza-1-2b");
		if (!model) throw new Error("missing test catalog model");
		// Serve the manifest but 404 the text weight so the job fails after the
		// keep-awake hold has already been acquired.
		const files = freshBundleFixtureFiles();
		files.delete(eliza1BundleRemotePath("text/eliza-1-2b-128k.gguf"));
		installFetchFixture(files);
		const spy = installKeepAwakeSpy();
		try {
			const downloader = new Downloader({
				probeDeviceCaps: async () => cpuOnlyCaps,
			});
			const completed = waitForTerminal(downloader, model.id);
			await downloader.start(model.id);
			await expect(completed).rejects.toThrow();
			await settleReleases(spy.calls);

			expect(spy.calls).toContain(true);
			expect(spy.calls.at(-1)).toBe(false);
			const acquires = spy.calls.filter((on) => on).length;
			const releases = spy.calls.filter((on) => !on).length;
			expect(acquires).toBe(releases);
		} finally {
			spy.restore();
		}
	});

	it("never lets a throwing keep-awake bridge break the download", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-download-test-"));
		process.env.ELIZA_STATE_DIR = root;
		const model = findCatalogModel("eliza-1-2b");
		if (!model) throw new Error("missing test catalog model");
		installFetchFixture(freshBundleFixtureFiles());
		const spy = installKeepAwakeSpy(() => {
			throw new Error("bridge exploded");
		});
		try {
			const downloader = new Downloader({
				probeDeviceCaps: async () => cpuOnlyCaps,
			});
			const completed = waitForTerminal(downloader, model.id);
			await downloader.start(model.id);
			const job = await completed;
			await settleReleases(spy.calls);

			// The download still succeeds — a keep-awake failure is swallowed and
			// must never take the transfer down with it.
			expect(job.state).toBe("completed");
			// Both edges were still attempted despite each throwing.
			expect(spy.calls).toContain(true);
			expect(spy.calls).toContain(false);
		} finally {
			spy.restore();
		}
	});
});

describe("local inference downloader native background URLSession path (#11841)", () => {
	type BgArgs = {
		id: string;
		url: string;
		headers: Record<string, string>;
		destPath: string;
		expectedTotalBytes: number;
	};
	type BgSnapshot = {
		id: string;
		state: "running" | "completed" | "failed" | "cancelled";
		received: number;
		total: number;
		destPath: string;
		error?: string;
	};
	type BgBridgeGlobal = {
		__ELIZA_BRIDGE__?: Record<string, unknown>;
	};

	/**
	 * Stand in for the native iOS `BackgroundDownloadBridge` the runtime installs
	 * on `globalThis.__ELIZA_BRIDGE__`. Resolves each requested URL against the
	 * fetch fixture bodies, writes the bytes straight to the downloader's staging
	 * `destPath` (as the real native session's `didFinishDownloadingTo` move
	 * does), and reports terminal state synchronously so the downloader's poll
	 * loop observes completion on its first `bg_download_status` call.
	 */
	function installBackgroundDownloadFixture(files: Map<string, string>): {
		starts: BgArgs[];
		restore: () => void;
	} {
		const starts: BgArgs[] = [];
		const jobs = new Map<string, BgSnapshot>();
		const g = globalThis as BgBridgeGlobal;
		const hadBridge = "__ELIZA_BRIDGE__" in g;
		const priorBridge = g.__ELIZA_BRIDGE__;

		g.__ELIZA_BRIDGE__ = {
			...(priorBridge ?? {}),
			bg_download_start: async (raw: unknown): Promise<BgSnapshot> => {
				const args = raw as BgArgs;
				starts.push(args);
				const remotePath = remotePathOf(args.url);
				const body = files.get(remotePath);
				if (body === undefined) {
					const snap: BgSnapshot = {
						id: args.id,
						state: "failed",
						received: 0,
						total: 0,
						destPath: args.destPath,
						error: `missing ${remotePath}`,
					};
					jobs.set(args.id, snap);
					return snap;
				}
				fs.mkdirSync(path.dirname(args.destPath), { recursive: true });
				fs.writeFileSync(args.destPath, body);
				const size = Buffer.byteLength(body);
				const snap: BgSnapshot = {
					id: args.id,
					state: "completed",
					received: size,
					total: size,
					destPath: args.destPath,
				};
				jobs.set(args.id, snap);
				return snap;
			},
			bg_download_status: async (raw: unknown): Promise<BgSnapshot> => {
				const { id } = raw as { id: string };
				return (
					jobs.get(id) ?? {
						id,
						state: "failed",
						received: 0,
						total: 0,
						destPath: "",
						error: `unknown id ${id}`,
					}
				);
			},
			bg_download_cancel: async (raw: unknown): Promise<BgSnapshot> => {
				const { id } = raw as { id: string };
				const snap = jobs.get(id);
				if (snap) snap.state = "cancelled";
				return (
					snap ?? {
						id,
						state: "cancelled",
						received: 0,
						total: 0,
						destPath: "",
					}
				);
			},
		};

		return {
			starts,
			restore: () => {
				if (hadBridge) g.__ELIZA_BRIDGE__ = priorBridge;
				else delete g.__ELIZA_BRIDGE__;
			},
		};
	}

	it("installs the bundle through the native bridge without any in-process fetch", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-download-test-"));
		process.env.ELIZA_STATE_DIR = root;
		const model = findCatalogModel("eliza-1-2b");
		if (!model) throw new Error("missing test catalog model");

		// Any in-process fetch on the native path is a routing bug — fail loudly.
		const fetchSpy = vi.fn(async () => {
			throw new Error(
				"fetch must not be used when the native bridge is present",
			);
		});
		globalThis.fetch = fetchSpy as unknown as typeof fetch;
		const bg = installBackgroundDownloadFixture(freshBundleFixtureFiles());
		try {
			const downloader = new Downloader({
				probeDeviceCaps: async () => cpuOnlyCaps,
			});
			const completed = waitForTerminal(downloader, model.id);
			await downloader.start(model.id);
			const job = await completed;

			expect(job.state).toBe("completed");
			expect(fetchSpy).not.toHaveBeenCalled();
			// Every bundle file (manifest + weights) was pulled via the bridge.
			expect(bg.starts.length).toBeGreaterThan(1);
			const installed = (await listInstalledModels()).find(
				(m) => m.id === model.id,
			);
			expect(installed).toBeDefined();
		} finally {
			bg.restore();
		}
	});

	it("fails the job when the native bridge reports a failed transfer", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-download-test-"));
		process.env.ELIZA_STATE_DIR = root;
		const model = findCatalogModel("eliza-1-2b");
		if (!model) throw new Error("missing test catalog model");

		// Serve the manifest but drop the text weight so the native transfer for
		// that file reports `failed` and the job surfaces the failure.
		const files = freshBundleFixtureFiles();
		files.delete(eliza1BundleRemotePath("text/eliza-1-2b-128k.gguf"));
		globalThis.fetch = vi.fn(async () => {
			throw new Error(
				"fetch must not be used when the native bridge is present",
			);
		}) as unknown as typeof fetch;
		const bg = installBackgroundDownloadFixture(files);
		try {
			const downloader = new Downloader({
				probeDeviceCaps: async () => cpuOnlyCaps,
			});
			const completed = waitForTerminal(downloader, model.id);
			await downloader.start(model.id);
			await expect(completed).rejects.toThrow();
		} finally {
			bg.restore();
		}
	});
});
