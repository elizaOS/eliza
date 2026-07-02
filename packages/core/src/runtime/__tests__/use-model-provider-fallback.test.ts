import { describe, expect, it, vi } from "vitest";
import { InMemoryDatabaseAdapter } from "../../database/inMemoryAdapter";
import { AgentRuntime } from "../../runtime";
import { type Character, ModelType } from "../../types";

function makeRuntime(): AgentRuntime {
	return new AgentRuntime({
		character: {
			name: "ProviderFallbackAgent",
			bio: "test",
			settings: {},
		} as Character,
		adapter: new InMemoryDatabaseAdapter(),
		logLevel: "fatal",
	});
}

function statusError(statusCode: number, message: string): Error {
	const error = new Error(message) as Error & { statusCode: number };
	error.statusCode = statusCode;
	return error;
}

describe("AgentRuntime.useModel provider fallback", () => {
	it("falls through to the next provider when the preferred provider is rate-limited", async () => {
		const runtime = makeRuntime();
		const cliSdkFails = vi.fn(async () => {
			throw statusError(429, "you have hit your session limit");
		});
		const cloudOk = vi.fn(async () => "cloud-response");

		runtime.registerModel(ModelType.TEXT_LARGE, cliSdkFails, "claude-sdk", 100);
		runtime.registerModel(ModelType.TEXT_LARGE, cloudOk, "eliza-cloud", 10);

		await expect(
			runtime.useModel(ModelType.TEXT_LARGE, { prompt: "hello" }),
		).resolves.toBe("cloud-response");
		expect(cliSdkFails).toHaveBeenCalledTimes(1);
		expect(cloudOk).toHaveBeenCalledTimes(1);
	});

	it("falls through on transient 5xx provider failures", async () => {
		const runtime = makeRuntime();
		const unavailable = vi.fn(async () => {
			throw statusError(503, "service unavailable");
		});
		const directApiOk = vi.fn(async () => "direct-api-response");

		runtime.registerModel(ModelType.TEXT_LARGE, unavailable, "claude-sdk", 100);
		runtime.registerModel(ModelType.TEXT_LARGE, directApiOk, "anthropic", 10);

		await expect(
			runtime.useModel(ModelType.TEXT_LARGE, { prompt: "hello" }),
		).resolves.toBe("direct-api-response");
		expect(unavailable).toHaveBeenCalledTimes(1);
		expect(directApiOk).toHaveBeenCalledTimes(1);
	});

	it("falls through on Anthropic 529 overloaded provider failures", async () => {
		const runtime = makeRuntime();
		const overloaded = vi.fn(async () => {
			throw statusError(
				529,
				"API Error: 529 Overloaded. This is a server-side issue.",
			);
		});
		const openRouterOk = vi.fn(async () => "openrouter-response");

		runtime.registerModel(ModelType.TEXT_LARGE, overloaded, "claude-sdk", 100);
		runtime.registerModel(ModelType.TEXT_LARGE, openRouterOk, "openrouter", 10);

		await expect(
			runtime.useModel(ModelType.TEXT_LARGE, { prompt: "hello" }),
		).resolves.toBe("openrouter-response");
		expect(overloaded).toHaveBeenCalledTimes(1);
		expect(openRouterOk).toHaveBeenCalledTimes(1);
	});

	it("does not fall through for non-retryable provider errors", async () => {
		const runtime = makeRuntime();
		const badRequest = vi.fn(async () => {
			throw statusError(400, "bad request");
		});
		const backup = vi.fn(async () => "unused");

		runtime.registerModel(ModelType.TEXT_LARGE, badRequest, "claude-sdk", 100);
		runtime.registerModel(ModelType.TEXT_LARGE, backup, "eliza-cloud", 10);

		await expect(
			runtime.useModel(ModelType.TEXT_LARGE, { prompt: "hello" }),
		).rejects.toThrow("bad request");
		expect(badRequest).toHaveBeenCalledTimes(1);
		expect(backup).not.toHaveBeenCalled();
	});

	it("honors an explicitly pinned provider instead of trying another provider", async () => {
		const runtime = makeRuntime();
		const cliSdkFails = vi.fn(async () => {
			throw statusError(429, "you have hit your session limit");
		});
		const cloudOk = vi.fn(async () => "unused");

		runtime.registerModel(ModelType.TEXT_LARGE, cliSdkFails, "claude-sdk", 100);
		runtime.registerModel(ModelType.TEXT_LARGE, cloudOk, "eliza-cloud", 10);

		await expect(
			runtime.useModel(ModelType.TEXT_LARGE, { prompt: "hello" }, "claude-sdk"),
		).rejects.toThrow("session limit");
		expect(cliSdkFails).toHaveBeenCalledTimes(1);
		expect(cloudOk).not.toHaveBeenCalled();
	});
});
