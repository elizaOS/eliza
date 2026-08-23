import { describe, expect, it } from "vitest";
import {
	resolveDirectRequestOrigin,
	resolveRequestOrigin,
} from "./request-origin.ts";

function req(overrides: Record<string, unknown> = {}) {
	return {
		headers: {},
		socket: {},
		...overrides,
	} as never;
}

describe("resolveDirectRequestOrigin", () => {
	it("builds http origin from the host header", () => {
		expect(
			resolveDirectRequestOrigin(req({ headers: { host: "example.com" } })),
		).toBe("http://example.com");
	});

	it("uses https for encrypted sockets", () => {
		expect(
			resolveDirectRequestOrigin(
				req({ headers: { host: "example.com" }, socket: { encrypted: true } }),
			),
		).toBe("https://example.com");
	});

	it("returns empty when no host", () => {
		expect(resolveDirectRequestOrigin(req({}))).toBe("");
	});

	it("takes the first comma-separated host", () => {
		expect(
			resolveDirectRequestOrigin(req({ headers: { host: "a.com, b.com" } })),
		).toBe("http://a.com");
	});
});

describe("resolveRequestOrigin", () => {
	it("prefers forwarded proto and host", () => {
		expect(
			resolveRequestOrigin(
				req({
					headers: {
						host: "internal:8080",
						"x-forwarded-proto": "https",
						"x-forwarded-host": "public.example.com",
					},
				}),
			),
		).toBe("https://public.example.com");
	});

	it("falls back to direct headers", () => {
		expect(
			resolveRequestOrigin(
				req({ headers: { host: "example.com" }, socket: { encrypted: true } }),
			),
		).toBe("https://example.com");
	});

	it("returns empty when nothing available", () => {
		expect(resolveRequestOrigin(req({}))).toBe("");
	});
});
