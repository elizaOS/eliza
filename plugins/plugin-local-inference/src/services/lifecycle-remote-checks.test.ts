/** Covers remote lifecycle checks: request headers, URL validation, and manifest file-path flattening for hosted bundles. Deterministic. */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	checkLifecycleUrl,
	collectLifecycleBundleChecks,
	flattenManifestFilePaths,
	lifecycleRequestHeaders,
} from "./lifecycle-remote-checks";
import type { CatalogModel } from "./types";

/**
 * Force the direct (unauthenticated) HuggingFace base so tests never read the
 * sealed cloud-secret store on the host running them.
 */
const DIRECT_BASE = "https://huggingface.co";

interface RecordedRequest {
	url: string;
	method: string;
	headers: Record<string, string>;
}

function fakeFetch(
	handler: (url: string, init: RequestInit, calls: number) => Response,
): { fetchImpl: typeof fetch; requests: RecordedRequest[] } {
	const requests: RecordedRequest[] = [];
	let calls = 0;
	const fetchImpl = (async (
		input: string | URL | Request,
		init?: RequestInit,
	) => {
		calls += 1;
		const url = String(input);
		requests.push({
			url,
			method: init?.method ?? "GET",
			headers: { ...(init?.headers as Record<string, string>) },
		});
		return handler(url, init ?? {}, calls);
	}) as typeof fetch;
	return { fetchImpl, requests };
}

function response(status: number, body = ""): Response {
	// Response cannot carry bodies for 204/205/304; plain text is fine here.
	return new Response(status === 204 ? null : body, {
		status,
		statusText: "",
	});
}

const noSleep = async () => {};

describe("lifecycleRequestHeaders", () => {
	it("mirrors the downloader user-agent and merges the resolved auth header", () => {
		const headers = lifecycleRequestHeaders({
			base: "https://cloud.example/api/v1/hf-proxy",
			authHeader: { authorization: "Bearer cloud-key" },
			viaCloud: true,
		});
		expect(headers["user-agent"]).toBe("Eliza-LocalInference/1.0");
		expect(headers.authorization).toBe("Bearer cloud-key");
	});

	it("sends no authorization on the direct public path", () => {
		const headers = lifecycleRequestHeaders({
			base: DIRECT_BASE,
			viaCloud: false,
		});
		expect(headers["user-agent"]).toBe("Eliza-LocalInference/1.0");
		expect(headers.authorization).toBeUndefined();
	});
});

describe("checkLifecycleUrl", () => {
	beforeEach(() => {
		process.env.ELIZA_HF_BASE_URL = DIRECT_BASE;
	});
	afterEach(() => {
		delete process.env.ELIZA_HF_BASE_URL;
	});

	it("passes on HTTP 200 and records the status", async () => {
		const { fetchImpl, requests } = fakeFetch(() => response(200));
		const check = await checkLifecycleUrl("https://huggingface.co/x", {
			fetchImpl,
			sleep: noSleep,
		});
		expect(check.status).toBe("pass");
		expect(check.httpStatus).toBe(200);
		expect(requests[0]?.method).toBe("HEAD");
		expect(requests[0]?.headers["user-agent"]).toBe("Eliza-LocalInference/1.0");
	});

	it("falls back to a 1-byte ranged GET when HEAD is rejected with 405", async () => {
		const { fetchImpl, requests } = fakeFetch((_url, init) =>
			init.method === "HEAD" ? response(405) : response(206),
		);
		const check = await checkLifecycleUrl("https://huggingface.co/x", {
			fetchImpl,
			sleep: noSleep,
		});
		expect(check.status).toBe("pass");
		expect(check.httpStatus).toBe(206);
		expect(requests).toHaveLength(2);
		expect(requests[1]?.method).toBe("GET");
		expect(requests[1]?.headers.Range).toBe("bytes=0-0");
	});

	it("fails definitively on HTTP 404", async () => {
		const { fetchImpl, requests } = fakeFetch(() => response(404));
		const check = await checkLifecycleUrl("https://huggingface.co/x", {
			fetchImpl,
			sleep: noSleep,
		});
		expect(check.status).toBe("fail");
		expect(check.httpStatus).toBe(404);
		expect(requests).toHaveLength(1);
	});

	it("retries 429 and degrades to warn (not fail) when rate limiting persists", async () => {
		const { fetchImpl, requests } = fakeFetch(() => response(429));
		const check = await checkLifecycleUrl("https://huggingface.co/x", {
			fetchImpl,
			sleep: noSleep,
			transientAttempts: 3,
		});
		expect(check.status).toBe("warn");
		expect(check.httpStatus).toBe(429);
		expect(check.detail).toContain("transient HTTP 429");
		expect(requests).toHaveLength(3);
	});

	it("recovers to pass when a transient 503 clears on retry", async () => {
		const { fetchImpl } = fakeFetch((_url, _init, calls) =>
			calls === 1 ? response(503) : response(200),
		);
		const check = await checkLifecycleUrl("https://huggingface.co/x", {
			fetchImpl,
			sleep: noSleep,
		});
		expect(check.status).toBe("pass");
		expect(check.httpStatus).toBe(200);
	});

	it("returns warn (inconclusive) on network errors", async () => {
		const fetchImpl = (async () => {
			throw new Error("ECONNRESET");
		}) as typeof fetch;
		const check = await checkLifecycleUrl("https://huggingface.co/x", {
			fetchImpl,
			sleep: noSleep,
		});
		expect(check.status).toBe("warn");
		expect(check.detail).toContain("ECONNRESET");
	});
});

describe("flattenManifestFilePaths", () => {
	it("collects paths from scalar and array file entries, deduped and sorted", () => {
		const manifest = {
			files: {
				text: { path: "text/model.gguf", ctx: 131072 },
				voice: [
					{ path: "tts/kokoro/model.gguf" },
					{ path: "tts/kokoro/tokenizer.json" },
					{ path: "text/model.gguf" },
				],
			},
		};
		expect(flattenManifestFilePaths(manifest)).toEqual([
			"text/model.gguf",
			"tts/kokoro/model.gguf",
			"tts/kokoro/tokenizer.json",
		]);
	});

	it("returns [] for malformed manifests", () => {
		expect(flattenManifestFilePaths(null)).toEqual([]);
		expect(flattenManifestFilePaths({ files: "nope" })).toEqual([]);
	});
});

describe("collectLifecycleBundleChecks", () => {
	beforeEach(() => {
		process.env.ELIZA_HF_BASE_URL = DIRECT_BASE;
	});
	afterEach(() => {
		delete process.env.ELIZA_HF_BASE_URL;
	});

	const model: CatalogModel = {
		id: "eliza-1-2b",
		displayName: "eliza-1-2B",
		hfRepo: "elizaos/eliza-1",
		hfPathPrefix: "bundles/2b",
		ggufFile: "text/eliza-1-2b-128k.gguf",
		bundleManifestFile: "eliza-1.manifest.json",
		params: "2B",
		quant: "test",
		sizeGb: 1.4,
		minRamGb: 4,
		category: "chat",
		bucket: "small",
		blurb: "test",
		contextLength: 131072,
	};

	const manifestBody = JSON.stringify({
		files: {
			text: { path: "text/eliza-1-2b-128k.gguf" },
			vad: [
				{ path: "vad/silero-vad-v5.gguf" },
				{ path: "vad/silero-vad-int8.onnx" },
			],
		},
	});

	it("fails the bundle when a manifest file definitively 404s, listing it", async () => {
		const { fetchImpl } = fakeFetch((url, init) => {
			if (url.includes("eliza-1.manifest.json")) {
				return init.method === "HEAD"
					? response(200)
					: response(200, manifestBody);
			}
			return url.includes("silero-vad-int8.onnx")
				? response(404)
				: response(200);
		});
		const checks = await collectLifecycleBundleChecks(
			{ fetchImpl, sleep: noSleep },
			[model],
		);
		const bundle = checks["eliza-1-2b"];
		expect(bundle?.status).toBe("fail");
		expect(bundle?.fileCount).toBe(3);
		expect(bundle?.failingFiles).toHaveLength(1);
		expect(bundle?.failingFiles[0]?.path).toBe("vad/silero-vad-int8.onnx");
		expect(bundle?.failingFiles[0]?.httpStatus).toBe(404);
	});

	it("warns (not fails) when the only non-passing files are transient", async () => {
		const { fetchImpl } = fakeFetch((url, init) => {
			if (url.includes("eliza-1.manifest.json")) {
				return init.method === "HEAD"
					? response(200)
					: response(200, manifestBody);
			}
			return url.includes("silero-vad-int8.onnx")
				? response(429)
				: response(200);
		});
		const checks = await collectLifecycleBundleChecks(
			{ fetchImpl, sleep: noSleep, transientAttempts: 2 },
			[model],
		);
		const bundle = checks["eliza-1-2b"];
		expect(bundle?.status).toBe("warn");
		expect(bundle?.detail).toContain("inconclusive");
		expect(bundle?.failingFiles[0]?.status).toBe("warn");
	});

	it("passes when every manifest file resolves", async () => {
		const { fetchImpl } = fakeFetch((url, init) => {
			if (url.includes("eliza-1.manifest.json") && init.method === "GET") {
				return response(200, manifestBody);
			}
			return response(200);
		});
		const checks = await collectLifecycleBundleChecks(
			{ fetchImpl, sleep: noSleep },
			[model],
		);
		expect(checks["eliza-1-2b"]?.status).toBe("pass");
		expect(checks["eliza-1-2b"]?.fileCount).toBe(3);
	});

	it("reports manifest unavailability without probing files", async () => {
		const { fetchImpl, requests } = fakeFetch(() => response(404));
		const checks = await collectLifecycleBundleChecks(
			{ fetchImpl, sleep: noSleep },
			[model],
		);
		expect(checks["eliza-1-2b"]?.status).toBe("fail");
		expect(checks["eliza-1-2b"]?.detail).toContain("manifest unavailable");
		expect(requests).toHaveLength(1);
	});
});
