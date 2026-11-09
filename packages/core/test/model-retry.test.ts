import { describe, expect, it } from "vitest";
import { parseProviderRateLimit } from "../src/utils/model-retry";

describe("parseProviderRateLimit reset fields", () => {
	it("keeps a lone valid resetAt", () => {
		expect(
			parseProviderRateLimit({
				kind: "rate_limited",
				retryAfterMs: 5000,
				resetAt: "2026-11-01T00:00:00.000Z",
			}),
		).toEqual({
			kind: "rate_limited",
			retryAfterMs: 5000,
			resetAt: "2026-11-01T00:00:00.000Z",
		});
	});

	it("keeps resetAt with resetAfterSeconds", () => {
		expect(
			parseProviderRateLimit({
				kind: "rate_limited",
				retryAfterMs: 5000,
				resetAt: "2026-11-01T00:00:00.000Z",
				resetAfterSeconds: 42,
			}),
		).toEqual({
			kind: "rate_limited",
			retryAfterMs: 5000,
			resetAt: "2026-11-01T00:00:00.000Z",
			resetAfterSeconds: 42,
		});
	});

	it("drops a lone resetAfterSeconds without resetAt", () => {
		expect(
			parseProviderRateLimit({
				kind: "rate_limited",
				retryAfterMs: 5000,
				resetAfterSeconds: 42,
			}),
		).toEqual({
			kind: "rate_limited",
			retryAfterMs: 5000,
		});
	});

	it("drops a malformed resetAt", () => {
		expect(
			parseProviderRateLimit({
				kind: "rate_limited",
				retryAfterMs: 5000,
				resetAt: "not-a-date",
				resetAfterSeconds: 42,
			}),
		).toEqual({
			kind: "rate_limited",
			retryAfterMs: 5000,
		});
	});
});
