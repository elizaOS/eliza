import { describe, expect, it } from "vitest";
import { parseProviderRateLimit } from "../src/utils/model-retry";

describe("parseProviderRateLimit resetAt", () => {
	it("keeps resetAt when the provider sends no resetAfterSeconds", () => {
		expect(
			parseProviderRateLimit({
				kind: "rate_limited",
				retryAfterMs: 1000,
				resetAt: "2026-11-12T00:00:00Z",
			}),
		).toEqual({
			kind: "rate_limited",
			retryAfterMs: 1000,
			resetAt: "2026-11-12T00:00:00.000Z",
		});
	});

	it("still keeps both fields when both are sent", () => {
		expect(
			parseProviderRateLimit({
				kind: "rate_limited",
				retryAfterMs: 1000,
				resetAt: "2026-11-12T00:00:00Z",
				resetAfterSeconds: 3600,
			}),
		).toEqual({
			kind: "rate_limited",
			retryAfterMs: 1000,
			resetAt: "2026-11-12T00:00:00.000Z",
			resetAfterSeconds: 3600,
		});
	});

	it("still drops resetAfterSeconds when resetAt is absent", () => {
		expect(
			parseProviderRateLimit({
				kind: "rate_limited",
				retryAfterMs: 1000,
				resetAfterSeconds: 3600,
			}),
		).toEqual({ kind: "rate_limited", retryAfterMs: 1000 });
	});
});
