/** Exercises provider and connector authoring primitives at their public contracts. */
import { describe, expect, it, vi } from "vitest";
import {
	normalizeConnectorAccountId,
	normalizeProviderUsage,
	registerProviderModels,
	selectConnectorCredential,
	selectDefaultConnectorAccountId,
	summarizeProviderError,
} from "../index.node";

describe("provider authoring", () => {
	it("normalizes SDK aliases and rejects malformed counts", () => {
		expect(
			normalizeProviderUsage({
				inputTokens: 4,
				outputTokens: 2,
				cachedInputTokens: 3,
				outputTokenDetails: { reasoningTokens: 1 },
				totalTokens: Number.NaN,
			}),
		).toEqual({
			promptTokens: 4,
			completionTokens: 2,
			totalTokens: 6,
			cacheReadInputTokens: 3,
			reasoningTokens: 1,
		});
	});

	it("validates duplicate registrations before mutating the runtime", () => {
		const registerModel = vi.fn();
		const handler = vi.fn(async () => ({}));
		expect(() =>
			registerProviderModels({ registerModel }, "provider", [
				{ modelType: "text", handler },
				{ modelType: "text", handler },
			]),
		).toThrow("Duplicate model registration");
		expect(registerModel).not.toHaveBeenCalled();
	});

	it("summarizes provider errors without copying secret-bearing response data", () => {
		const error = Object.assign(new Error("request failed"), {
			statusCode: 401,
			code: "unauthorized",
			responseBody: { authorization: "Bearer secret" },
			apiKey: "secret",
		});
		expect(summarizeProviderError(error)).toEqual({
			name: "Error",
			message: "request failed",
			status: 401,
			code: "unauthorized",
		});
	});
});

describe("connector authoring", () => {
	it("normalizes identifiers and selects the established default", () => {
		expect(normalizeConnectorAccountId(" Primary ")).toBe("primary");
		expect(normalizeConnectorAccountId(" ")).toBe("default");
		expect(selectDefaultConnectorAccountId(["secondary", "default"])).toBe(
			"default",
		);
		expect(selectDefaultConnectorAccountId(["primary"])).toBe("primary");
	});

	it("delegates credential policy and preserves source precedence", () => {
		const selected = selectConnectorCredential(
			[
				{ source: "character", value: " invalid " },
				{ source: "env", value: " xoxb-secret " },
			],
			(value) => {
				const trimmed = value?.trim();
				return trimmed?.startsWith("xoxb-") ? trimmed : undefined;
			},
		);
		expect(selected).toEqual({ source: "env", credential: "xoxb-secret" });
	});
});
