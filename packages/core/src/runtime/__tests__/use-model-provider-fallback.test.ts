/**
 * Unit tests for AgentRuntime.useModel provider fallback: rotation to a
 * lower-priority provider on retryable (429 / 5xx / 529 / fetch-failed) errors,
 * failing closed for non-retryable errors and TTS slots, and honoring a pinned
 * provider. Drives a real AgentRuntime + InMemoryDatabaseAdapter with vi.fn
 * model handlers — no live model calls.
 */
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

	it("does NOT fall over for TEXT_TO_SPEECH, even on a transient-looking error (voice fails closed #12253)", async () => {
		const runtime = makeRuntime();
		// A Kokoro model-download failure surfaces as "fetch failed", which the
		// transient heuristic matches for text slots — but a voice swap is never
		// transient-recoverable, so TTS must fail closed rather than rotate to a
		// different voice engine.
		const kokoroFails = vi.fn(async () => {
			throw new Error("fetch failed: kokoro artifacts unreachable");
		});
		const edgeTts = vi.fn(async () => new Uint8Array([1, 2, 3]));

		runtime.registerModel(
			ModelType.TEXT_TO_SPEECH,
			kokoroFails,
			"eliza-local-inference",
			100,
		);
		runtime.registerModel(ModelType.TEXT_TO_SPEECH, edgeTts, "edge-tts", 10);

		await expect(
			runtime.useModel(ModelType.TEXT_TO_SPEECH, { text: "hello" }),
		).rejects.toThrow("fetch failed");
		expect(kokoroFails).toHaveBeenCalledTimes(1);
		expect(edgeTts).not.toHaveBeenCalled();
	});

	it("still falls over for a text slot on the same fetch-failed error (heuristic intact)", async () => {
		const runtime = makeRuntime();
		const primary = vi.fn(async () => {
			throw new Error("fetch failed");
		});
		const backup = vi.fn(async () => "backup-response");

		runtime.registerModel(ModelType.TEXT_LARGE, primary, "claude-sdk", 100);
		runtime.registerModel(ModelType.TEXT_LARGE, backup, "eliza-cloud", 10);

		await expect(
			runtime.useModel(ModelType.TEXT_LARGE, { prompt: "hello" }),
		).resolves.toBe("backup-response");
		expect(primary).toHaveBeenCalledTimes(1);
		expect(backup).toHaveBeenCalledTimes(1);
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
