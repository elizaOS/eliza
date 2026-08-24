/**
 * Regression coverage for resumed model downloads in the route-level
 * `downloadModel` path, exercised through the real exported
 * `applyLocalInferenceManagementMutation({ op: "start_download" })` handler with
 * a temp `ELIZA_STATE_DIR` and a real local HTTP origin (issue #26629).
 *
 * Before the fix, `downloadModel` sent `Range: bytes=<n>-` whenever a `.part`
 * file existed and then opened the staging file in append mode without checking
 * that the origin honored the range. A CDN/mirror/gated-proxy that ignores Range
 * and answers HTTP 200 with the FULL body had that body appended onto the stale
 * partial bytes, producing a corrupt GGUF that still passed the 4-byte magic
 * gate, was renamed to final, and registered as an installed model with a
 * miscomputed size (`existingPartial + fullSize`).
 *
 * These tests stand up local origins that model the compliant server (206 + the
 * remaining bytes), the CDN/mirror that ignores Range (200 + the full body), and
 * misbehaving proxies that answer 206 with a Content-Range whose start is
 * misaligned to — or missing for — the requested resume offset. Each seeds a
 * stale `.part`, drives the real mutation, and asserts the final
 * `models/<id>.gguf` bytes exactly equal the full file plus that the registry
 * size matches the true file length. No mocks: real fs + real HTTP; only
 * `ELIZA_STATE_DIR` and `ELIZA_HF_BASE_URL` are redirected.
 */
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyLocalInferenceManagementMutation } from "./local-inference-routes.js";

const MODEL_ID = "eliza-1-2b";
// Full artifact the origin will ultimately serve. Begins with the GGUF magic so
// the 4-byte integrity gate cannot distinguish correct from corrupt output.
const FULL = Buffer.from("GGUFREAL-MODEL-BODY");
// Stale partial left behind by an interrupted attempt. Its first 4 bytes are
// also "GGUF", so a corrupt append still passes the magic check.
const STALE = Buffer.from("GGUFSTALE-PARTIAL");

const originalStateDir = process.env.ELIZA_STATE_DIR;
const originalHfBase = process.env.ELIZA_HF_BASE_URL;
const originalHfBases = process.env.ELIZA_HF_BASE_URLS;
const originalCloudKey = process.env.ELIZAOS_CLOUD_API_KEY;

let tempStateDir: string;
let server: http.Server;
let baseUrl: string;

function localInferenceRoot(): string {
	return path.join(tempStateDir, "local-inference");
}

function partialPath(): string {
	return path.join(localInferenceRoot(), "downloads", `${MODEL_ID}.part`);
}

function finalPath(): string {
	return path.join(localInferenceRoot(), "models", `${MODEL_ID}.gguf`);
}

function readRegistryFile(): {
	models: Array<{ id: string; sizeBytes: number; path: string }>;
} {
	return JSON.parse(
		readFileSync(path.join(localInferenceRoot(), "registry.json"), "utf8"),
	);
}

function seedStalePartial(): void {
	mkdirSync(path.join(localInferenceRoot(), "downloads"), { recursive: true });
	mkdirSync(path.join(localInferenceRoot(), "models"), { recursive: true });
	writeFileSync(partialPath(), STALE);
}

/**
 * Start a local origin. When `honorRange` is true it behaves like a compliant
 * server: a `Range: bytes=<n>-` request yields `206` with only the remaining
 * bytes. When false it models the misbehaving CDN/mirror/proxy: it ignores
 * Range entirely and always answers `200` with the full body.
 */
async function startOrigin(honorRange: boolean): Promise<void> {
	server = http.createServer((req, res) => {
		const range = req.headers.range;
		if (honorRange && typeof range === "string") {
			const match = /bytes=(\d+)-/.exec(range);
			const start = match ? Number.parseInt(match[1], 10) : 0;
			const slice = FULL.subarray(start);
			res.writeHead(206, {
				"content-length": String(slice.length),
				"content-range": `bytes ${start}-${FULL.length - 1}/${FULL.length}`,
			});
			res.end(slice);
			return;
		}
		res.writeHead(200, { "content-length": String(FULL.length) });
		res.end(FULL);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address() as { port: number };
	baseUrl = `http://127.0.0.1:${address.port}`;
	process.env.ELIZA_HF_BASE_URL = baseUrl;
}

/**
 * Start a misbehaving proxy origin: it always answers `206 Partial Content`
 * with the FULL body regardless of the requested Range, and stamps a
 * `Content-Range` header from `contentRange` (or omits it entirely when null).
 * This models a proxy that ignores Range semantics but still returns a 206
 * status — exactly the case where a naive `statusCode === 206` gate would
 * append the full body onto the stale partial and corrupt the GGUF.
 */
async function startMisalignedRangeOrigin(
	contentRange: string | null,
): Promise<void> {
	server = http.createServer((_req, res) => {
		const headers: Record<string, string> = {
			"content-length": String(FULL.length),
		};
		if (contentRange !== null) headers["content-range"] = contentRange;
		res.writeHead(206, headers);
		res.end(FULL);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address() as { port: number };
	baseUrl = `http://127.0.0.1:${address.port}`;
	process.env.ELIZA_HF_BASE_URL = baseUrl;
}

/**
 * Poll until the download job has fully completed — i.e. the registry row is
 * written. `downloadModel` renames the staging file into place BEFORE it hashes
 * and registers the model, so waiting only for the final file would race the
 * background completion (and the afterEach teardown). Return the registered
 * size so the caller can assert on it.
 */
async function waitForInstalledSize(): Promise<number> {
	for (let attempt = 0; attempt < 800; attempt += 1) {
		try {
			const entry = readRegistryFile().models.find(
				(model) => model.id === MODEL_ID,
			);
			if (entry) return entry.sizeBytes;
		} catch {
			// registry.json not written yet — keep polling.
		}
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	throw new Error("timed out waiting for the model to be installed");
}

describe("local-inference route resume download (#26629)", () => {
	beforeEach(() => {
		tempStateDir = mkdtempSync(path.join(tmpdir(), "eliza-li-resume-"));
		process.env.ELIZA_STATE_DIR = tempStateDir;
		// Force the mirror path to our local origin only — no cloud proxy or the
		// public HuggingFace fallback may be contacted from the test.
		delete process.env.ELIZA_HF_BASE_URLS;
		delete process.env.ELIZAOS_CLOUD_API_KEY;
		mkdirSync(localInferenceRoot(), { recursive: true });
	});

	afterEach(async () => {
		// Abort any in-flight download so a background transfer cannot write into
		// the temp dir after teardown or leak into the next test's module state.
		await applyLocalInferenceManagementMutation({ op: "cancel_download" });
		if (server) {
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
		rmSync(tempStateDir, { recursive: true, force: true });
		const restore = (key: string, value: string | undefined) => {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		};
		restore("ELIZA_STATE_DIR", originalStateDir);
		restore("ELIZA_HF_BASE_URL", originalHfBase);
		restore("ELIZA_HF_BASE_URLS", originalHfBases);
		restore("ELIZAOS_CLOUD_API_KEY", originalCloudKey);
	});

	it("restarts from byte 0 when the origin ignores Range and answers HTTP 200", async () => {
		seedStalePartial();
		await startOrigin(false);

		const result = await applyLocalInferenceManagementMutation({
			op: "start_download",
			modelId: MODEL_ID,
		});
		expect(result.op).toBe("start_download");

		// registry.json size must reflect the true file length, not the old
		// `existingPartial + fullSize` miscomputation.
		const installedSize = await waitForInstalledSize();
		expect(installedSize).toBe(FULL.length);

		const stored = readFileSync(finalPath());
		// The corrupt-append bug produced 36 bytes
		// ("GGUFSTALE-PARTIALGGUFREAL-MODEL-BODY"); the fix must yield exactly the
		// full body with the stale partial discarded.
		expect(stored.length).toBe(FULL.length);
		expect(stored.equals(FULL)).toBe(true);
	});

	it("restarts from byte 0 when a 206 Content-Range is misaligned to the requested offset", async () => {
		seedStalePartial();
		// STALE is 17 bytes, so the resume request is `Range: bytes=17-`. The proxy
		// answers 206 but claims the body starts at byte 0 — a misaligned range that
		// must NOT be appended onto the stale partial.
		await startMisalignedRangeOrigin(
			`bytes 0-${FULL.length - 1}/${FULL.length}`,
		);

		await applyLocalInferenceManagementMutation({
			op: "start_download",
			modelId: MODEL_ID,
		});

		const installedSize = await waitForInstalledSize();
		expect(installedSize).toBe(FULL.length);

		const stored = readFileSync(finalPath());
		expect(stored.length).toBe(FULL.length);
		expect(stored.equals(FULL)).toBe(true);
	});

	it("restarts from byte 0 when a 206 omits the Content-Range header", async () => {
		seedStalePartial();
		// A 206 with no Content-Range cannot be validated as aligned to the resume
		// offset, so the fix must fail closed and restart from byte 0.
		await startMisalignedRangeOrigin(null);

		await applyLocalInferenceManagementMutation({
			op: "start_download",
			modelId: MODEL_ID,
		});

		const installedSize = await waitForInstalledSize();
		expect(installedSize).toBe(FULL.length);

		const stored = readFileSync(finalPath());
		expect(stored.length).toBe(FULL.length);
		expect(stored.equals(FULL)).toBe(true);
	});

	it("resumes correctly when the origin honors Range with HTTP 206", async () => {
		// Seed a partial that is a genuine PREFIX of the full body, so a correct
		// 206 resume (append remaining bytes) reconstructs the exact file.
		const prefixLen = 4; // "GGUF"
		mkdirSync(path.join(localInferenceRoot(), "downloads"), {
			recursive: true,
		});
		mkdirSync(path.join(localInferenceRoot(), "models"), { recursive: true });
		writeFileSync(partialPath(), FULL.subarray(0, prefixLen));
		await startOrigin(true);

		await applyLocalInferenceManagementMutation({
			op: "start_download",
			modelId: MODEL_ID,
		});

		const installedSize = await waitForInstalledSize();
		expect(installedSize).toBe(FULL.length);

		const stored = readFileSync(finalPath());
		expect(stored.length).toBe(FULL.length);
		expect(stored.equals(FULL)).toBe(true);
	});
});
