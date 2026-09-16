/**
 * Deterministic tests for the trusted local media-store URL boundary
 * (`trustedLocalMediaUrl` in ./local-store.ts). The function under test is a
 * pure security predicate with a tri-state contract; environment stubbing is
 * limited to the three server-port keys owned by this suite, following the
 * pattern in ../utils/node.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getEnvironment } from "../utils/environment.js";
import { MediaFetchError } from "./fetch.js";
import { trustedLocalMediaUrl } from "./local-store.js";

const SHA = "a".repeat(64);

describe("trustedLocalMediaUrl", () => {
	const originalServerPort = process.env.SERVER_PORT;
	const originalElizaApiPort = process.env.ELIZA_API_PORT;
	const originalElizaPort = process.env.ELIZA_PORT;

	beforeEach(() => {
		delete process.env.SERVER_PORT;
		delete process.env.ELIZA_API_PORT;
		delete process.env.ELIZA_PORT;
		getEnvironment().clearCache();
	});

	afterEach(() => {
		getEnvironment().clearCache();
		if (originalServerPort === undefined) delete process.env.SERVER_PORT;
		else process.env.SERVER_PORT = originalServerPort;
		if (originalElizaApiPort === undefined) delete process.env.ELIZA_API_PORT;
		else process.env.ELIZA_API_PORT = originalElizaApiPort;
		if (originalElizaPort === undefined) delete process.env.ELIZA_PORT;
		else process.env.ELIZA_PORT = originalElizaPort;
	});

	describe("canonical relative handles resolve against the local origin", () => {
		it("resolves a well-formed sha256 handle on the default port", () => {
			const url = trustedLocalMediaUrl(`/api/media/${SHA}.png`);
			expect(url).toBeInstanceOf(URL);
			expect(url?.href).toBe(`http://localhost:3000/api/media/${SHA}.png`);
		});

		it("honors ELIZA_API_PORT over ELIZA_PORT and SERVER_PORT", () => {
			process.env.ELIZA_API_PORT = "32337";
			process.env.ELIZA_PORT = "32336";
			process.env.SERVER_PORT = "3001";
			getEnvironment().clearCache();
			const url = trustedLocalMediaUrl(`/api/media/${SHA}.jpg`);
			expect(url?.href).toBe(`http://localhost:32337/api/media/${SHA}.jpg`);
		});

		it("falls back to the legacy ELIZA_PORT alias when ELIZA_API_PORT is unset", () => {
			process.env.ELIZA_PORT = "32336";
			process.env.SERVER_PORT = "3001";
			getEnvironment().clearCache();
			const url = trustedLocalMediaUrl(`/api/media/${SHA}.webp`);
			expect(url?.href).toBe(`http://localhost:32336/api/media/${SHA}.webp`);
		});

		it("trims surrounding whitespace before classification", () => {
			const url = trustedLocalMediaUrl(`  /api/media/${SHA}.png  `);
			expect(url?.href).toBe(`http://localhost:3000/api/media/${SHA}.png`);
		});

		it("accepts the full extension length boundary (8 chars)", () => {
			const url = trustedLocalMediaUrl(`/api/media/${SHA}.abcdefgh`);
			expect(url?.pathname).toBe(`/api/media/${SHA}.abcdefgh`);
		});
	});

	describe("non-local URLs return null (routed to the SSRF-guarded fetcher)", () => {
		it("returns null for a remote-origin canonical-looking handle", () => {
			expect(
				trustedLocalMediaUrl(`http://evil.example/api/media/${SHA}.png`),
			).toBeNull();
		});

		it("returns null for a same-host different-port origin", () => {
			expect(
				trustedLocalMediaUrl(`http://localhost:9999/api/media/${SHA}.png`),
			).toBeNull();
		});

		it("returns null for other relative API paths", () => {
			expect(trustedLocalMediaUrl("/api/agents/123")).toBeNull();
			expect(trustedLocalMediaUrl("/media/file.png")).toBeNull();
		});

		it("returns null for unparseable absolute URLs", () => {
			expect(trustedLocalMediaUrl("http://")).toBeNull();
			expect(trustedLocalMediaUrl("not a url")).toBeNull();
			expect(trustedLocalMediaUrl("")).toBeNull();
		});
	});

	describe("local-looking non-canonical shapes throw MediaFetchError", () => {
		const expectFetchFailure = (raw: string): void => {
			let caught: unknown;
			try {
				trustedLocalMediaUrl(raw);
			} catch (error) {
				caught = error;
			}
			expect(caught).toBeInstanceOf(MediaFetchError);
			const err = caught as MediaFetchError;
			expect(err.code).toBe("fetch_failed");
			expect(err.name).toBe("MediaFetchError");
		};

		it("rejects malformed relative /api/media/ shapes", () => {
			expectFetchFailure(`/api/media/${SHA}.png/x`);
			expectFetchFailure(`/api/media/${"a".repeat(63)}.png`);
			expectFetchFailure(`/api/media/${SHA.toUpperCase()}.png`);
			expectFetchFailure("/api/media/not-a-hash.png");
			expectFetchFailure("/api/media/");
		});

		it("returns null for a bare /api/media prefix without a trailing path", () => {
			// Not a `/api/media/…` shape at all, so it classifies as a non-store
			// relative path (null) rather than a malformed store handle (throw).
			expect(trustedLocalMediaUrl("/api/media")).toBeNull();
		});

		it("rejects credentials on an own-origin URL", () => {
			expectFetchFailure(
				`http://user:pass@localhost:3000/api/media/${SHA}.png`,
			);
		});

		it("rejects query strings on an own-origin URL", () => {
			expectFetchFailure(`http://localhost:3000/api/media/${SHA}.png?token=x`);
		});

		it("rejects fragments on an own-origin URL", () => {
			expectFetchFailure(`http://localhost:3000/api/media/${SHA}.png#frag`);
		});

		it("rejects a wrong path on an own-origin URL", () => {
			expectFetchFailure(`http://localhost:3000/api/agents/${SHA}.png`);
		});
	});
});
