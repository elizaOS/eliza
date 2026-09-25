/**
 * Bionic-host UDS wire encoding (#8848).
 *
 * On the bionic-delegated path the musl agent forwards audio + image bytes to
 * the in-process bionic host over a Unix socket. Two pure helpers do the
 * framing: `float32ToBase64LE` packs mono fp32 PCM little-endian, and
 * `imageRequestToBase64` resolves a vision request to base64 image bytes. A
 * byte-order or prefix-stripping bug here corrupts every ASR/vision frame
 * silently (the host just gets garbage), so this pins the exact wire format.
 *
 * URL-kind images load through the shared `fetchRemoteMedia` SSRF guard so a
 * caller-supplied private or loopback host cannot be reached from vision.
 *
 * `ensure-local-inference-handler` has heavy import side-effects (the service
 * layer), so — like its sibling `ensure-local-inference-handler.test.ts` — the
 * service modules are stubbed before the import so the two encoders can be
 * exercised in isolation.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mediaMocks = vi.hoisted(() => ({
	fetchRemoteMedia: vi.fn(),
	useRealFetchRemoteMedia: false,
	realFetchRemoteMedia: null as
		| null
		| ((...args: unknown[]) => Promise<unknown>),
}));

vi.mock("@elizaos/core", async (importActual) => {
	const actual = await importActual<typeof import("@elizaos/core")>();
	mediaMocks.realFetchRemoteMedia = actual.fetchRemoteMedia as (
		...args: unknown[]
	) => Promise<unknown>;
	return {
		...actual,
		fetchRemoteMedia: (...args: unknown[]) => {
			if (
				mediaMocks.useRealFetchRemoteMedia &&
				mediaMocks.realFetchRemoteMedia
			) {
				return mediaMocks.realFetchRemoteMedia(...args);
			}
			return mediaMocks.fetchRemoteMedia(...args);
		},
	};
});

vi.mock("../services/active-model", () => ({
	resolveLocalInferenceLoadArgs: vi.fn(async (t) => t),
}));
vi.mock("../services/assignments", () => ({
	autoAssignAtBoot: vi.fn(async () => null),
	readEffectiveAssignments: vi.fn(async () => ({})),
}));
vi.mock("../services/cache-bridge", () => ({
	extractConversationId: vi.fn(() => null),
	extractPromptCacheKey: vi.fn(() => null),
	resolveLocalCacheKey: vi.fn(() => null),
}));
vi.mock("../services/device-bridge", () => ({
	deviceBridge: {
		currentModelPath: vi.fn(() => null),
		embed: vi.fn(),
		generate: vi.fn(),
		loadModel: vi.fn(),
		unloadModel: vi.fn(),
	},
}));
vi.mock("../services/engine", () => ({ localInferenceEngine: {} }));
vi.mock("../services/handler-registry", () => ({
	handlerRegistry: { installOn: vi.fn() },
}));
vi.mock("../services/hardware", () => ({
	probeHardware: vi.fn(async () => ({ memory: { totalGb: 8 } })),
}));
vi.mock("../services/memory-arbiter", () => ({
	tryGetMemoryArbiter: vi.fn(() => null),
}));
vi.mock("../services/registry", () => ({
	listInstalledModels: vi.fn(async () => []),
}));
vi.mock("../services/router-handler", () => ({
	installRouterHandler: vi.fn(),
}));
vi.mock("../services/voice", () => ({
	decodeMonoPcm16Wav: vi.fn(() => ({
		pcm: new Float32Array([0]),
		sampleRate: 16_000,
	})),
}));

import {
	float32ToBase64LE,
	imageRequestToBase64,
} from "./ensure-local-inference-handler";

afterEach(() => {
	mediaMocks.useRealFetchRemoteMedia = false;
	vi.restoreAllMocks();
	vi.clearAllMocks();
});

describe("float32ToBase64LE", () => {
	it("round-trips exactly-representable fp32 samples through base64 → readFloatLE", () => {
		// Every value is exactly representable in IEEE-754 binary32, so the decoded
		// values must equal the originals bit-for-bit (no float32 rounding drift).
		const pcm = new Float32Array([
			0, 1, -1, 0.5, -0.5, 0.25, -0.75, 3.5, -128.5, 32767.5,
		]);
		const buf = Buffer.from(float32ToBase64LE(pcm), "base64");
		expect(buf.length).toBe(pcm.length * 4);

		const decoded = new Float32Array(pcm.length);
		for (let i = 0; i < pcm.length; i += 1) {
			decoded[i] = buf.readFloatLE(i * 4);
		}
		expect(Array.from(decoded)).toEqual(Array.from(pcm));
	});

	it("encodes little-endian (1.0 → 00 00 80 3f)", () => {
		const buf = Buffer.from(float32ToBase64LE(new Float32Array([1])), "base64");
		expect([...buf]).toEqual([0x00, 0x00, 0x80, 0x3f]);
	});

	it("encodes an empty buffer as the empty string", () => {
		expect(float32ToBase64LE(new Float32Array(0))).toBe("");
	});
});

describe("imageRequestToBase64", () => {
	it("strips the data-URL header and returns the base64 payload", async () => {
		const payload = Buffer.from("hello bionic").toString("base64");
		await expect(
			imageRequestToBase64({
				kind: "dataUrl",
				dataUrl: `data:image/png;base64,${payload}`,
			}),
		).resolves.toBe(payload);
		expect(mediaMocks.fetchRemoteMedia).not.toHaveBeenCalled();
	});

	it("returns a comma-less dataUrl verbatim", async () => {
		await expect(
			imageRequestToBase64({ kind: "dataUrl", dataUrl: "rawbase64nocomma" }),
		).resolves.toBe("rawbase64nocomma");
	});

	it("loads a url through fetchRemoteMedia bounds then base64-encodes the bytes", async () => {
		const bytes = Buffer.from([1, 2, 3, 4]);
		mediaMocks.fetchRemoteMedia.mockResolvedValue({
			buffer: bytes,
			contentType: "image/png",
			fileName: "i.png",
		});

		await expect(
			imageRequestToBase64({ kind: "url", url: "https://example.test/i.png" }),
		).resolves.toBe(bytes.toString("base64"));
		expect(mediaMocks.fetchRemoteMedia).toHaveBeenCalledWith(
			expect.objectContaining({
				url: "https://example.test/i.png",
				maxBytes: 20 * 1024 * 1024,
				timeoutMs: 15_000,
				maxRedirects: 5,
			}),
		);
	});

	it("throws when the image URL is empty or whitespace instead of fetching", async () => {
		await expect(
			imageRequestToBase64({ kind: "url", url: "   " }),
		).rejects.toThrow("IMAGE_DESCRIPTION requires a valid image URL");
		expect(mediaMocks.fetchRemoteMedia).not.toHaveBeenCalled();
	});

	it("throws when the guarded image fetch fails", async () => {
		mediaMocks.fetchRemoteMedia.mockRejectedValue(
			new Error("Failed to fetch media from https://example.test/missing: 404"),
		);

		await expect(
			imageRequestToBase64({
				kind: "url",
				url: "https://example.test/missing",
			}),
		).rejects.toThrow(/failed to fetch.*missing/i);
	});

	it("throws when neither a dataUrl nor a url is resolvable", async () => {
		await expect(imageRequestToBase64({ kind: "dataUrl" })).rejects.toThrow(
			/could not resolve image bytes/,
		);
	});
});

describe("imageRequestToBase64 SSRF policy (real fetchRemoteMedia)", () => {
	beforeEach(() => {
		mediaMocks.useRealFetchRemoteMedia = true;
	});

	it.each([
		"http://127.0.0.1/secret.png",
		"http://[::1]/secret.png",
		"http://169.254.169.254/latest/meta-data/",
		"http://localhost/internal.png",
		"http://10.0.0.5/intranet.png",
		"http://192.168.1.1/router.png",
	])(
		"fails closed for blocked image URL %s without calling global fetch",
		async (url) => {
			const fetchMock = vi.fn();
			vi.spyOn(globalThis, "fetch").mockImplementation(
				fetchMock as typeof fetch,
			);

			await expect(imageRequestToBase64({ kind: "url", url })).rejects.toThrow(
				/Failed to fetch media|not allowed|blocked|private|loopback|link-local|Invalid URL|SSRF/i,
			);
			expect(fetchMock).not.toHaveBeenCalled();
		},
	);
});
