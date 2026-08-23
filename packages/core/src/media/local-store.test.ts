/**
 * Coverage for trusted local media-store URL resolution: canonical handle
 * acceptance, relative-path handling, own-origin matching, and rejection of
 * credentials/query/fragment and non-store shapes. getLocalServerUrl is
 * mocked so origin comparison is deterministic.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	getLocalServerUrl: vi.fn(),
	MediaFetchError: vi.fn(),
}));

vi.mock("../utils/node.ts", () => ({
	getLocalServerUrl: mocks.getLocalServerUrl,
}));

vi.mock("./fetch.ts", () => ({
	MediaFetchError: mocks.MediaFetchError,
}));

type LocalStoreModule = {
	VISION_IMAGE_FETCH_TIMEOUT_MS: number;
	VISION_IMAGE_MAX_BYTES: number;
	trustedLocalMediaUrl: (rawUrl: string) => URL | null;
};

async function loadLocalStore(): Promise<LocalStoreModule> {
	vi.resetModules();
	return import("./local-store.ts");
}

class MockMediaFetchError extends Error {
	code: string;
	constructor(code: string, message: string) {
		super(message);
		this.code = code;
		this.name = "MediaFetchError";
	}
}

beforeEach(() => {
	mocks.getLocalServerUrl.mockReset();
	mocks.MediaFetchError.mockReset();
	mocks.MediaFetchError.mockImplementation(function MockError(
		this: unknown,
		code: string,
		message: string,
	) {
		const err = new MockMediaFetchError(code, message);
		return err;
	});
});

describe("trustedLocalMediaUrl", () => {
	it("accepts a canonical relative handle and resolves it against the server url", async () => {
		mocks.getLocalServerUrl.mockImplementation((path: string) => {
			return `http://localhost:3000${path}`;
		});
		const mod = await loadLocalStore();
		const url = mod.trustedLocalMediaUrl(
			"/api/media/" + "a".repeat(64) + ".png",
		);
		expect(url?.href).toBe(
			"http://localhost:3000/api/media/" + "a".repeat(64) + ".png",
		);
	});

	it("returns null for non-media relative paths", async () => {
		const mod = await loadLocalStore();
		expect(mod.trustedLocalMediaUrl("/api/status")).toBeNull();
		expect(mod.trustedLocalMediaUrl("/health")).toBeNull();
	});

	it("throws for media paths that are not canonical store handles", async () => {
		const mod = await loadLocalStore();
		expect(() => mod.trustedLocalMediaUrl("/api/media/not-a-sha.png")).toThrow(
			MockMediaFetchError,
		);
		expect(() =>
			mod.trustedLocalMediaUrl("/api/media/" + "a".repeat(63) + ".png"),
		).toThrow(MockMediaFetchError);
	});

	it("returns null for non-local absolute URLs", async () => {
		mocks.getLocalServerUrl.mockReturnValue("http://localhost:3000/");
		const mod = await loadLocalStore();
		expect(
			mod.trustedLocalMediaUrl(
				"https://evil.example/api/media/" + "a".repeat(64) + ".png",
			),
		).toBeNull();
	});

	it("accepts an own-origin canonical handle", async () => {
		mocks.getLocalServerUrl.mockReturnValue("http://localhost:3000/");
		const mod = await loadLocalStore();
		const url = mod.trustedLocalMediaUrl(
			"http://localhost:3000/api/media/" + "b".repeat(64) + ".jpg",
		);
		expect(url?.href).toBe(
			"http://localhost:3000/api/media/" + "b".repeat(64) + ".jpg",
		);
	});

	it("throws for own-origin URLs with credentials, query, or fragment", async () => {
		mocks.getLocalServerUrl.mockReturnValue("http://localhost:3000/");
		const mod = await loadLocalStore();
		const handle = "/api/media/" + "c".repeat(64) + ".png";
		expect(() =>
			mod.trustedLocalMediaUrl(`http://user:pass@localhost:3000${handle}`),
		).toThrow(MockMediaFetchError);
		expect(() =>
			mod.trustedLocalMediaUrl(`http://localhost:3000${handle}?token=x`),
		).toThrow(MockMediaFetchError);
		expect(() =>
			mod.trustedLocalMediaUrl(`http://localhost:3000${handle}#frag`),
		).toThrow(MockMediaFetchError);
	});

	it("returns null for unparseable URLs", async () => {
		mocks.getLocalServerUrl.mockReturnValue("http://localhost:3000/");
		const mod = await loadLocalStore();
		// An invalid URL is not local — callers route it to the remote fetcher.
		expect(mod.trustedLocalMediaUrl("http://[::1")).toBeNull();
	});

	it("exposes the shared byte cap and timeout constants", async () => {
		const mod = await loadLocalStore();
		expect(mod.VISION_IMAGE_MAX_BYTES).toBe(20 * 1024 * 1024);
		expect(mod.VISION_IMAGE_FETCH_TIMEOUT_MS).toBe(15_000);
	});
});
