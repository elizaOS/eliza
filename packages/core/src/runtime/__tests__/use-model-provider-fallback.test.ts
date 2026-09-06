/**
 * Unit tests for AgentRuntime.useModel provider fallback: rotation to a
 * lower-priority provider on retryable (429 / 5xx / 529 / fetch-failed) errors,
 * failing closed for non-retryable errors and TTS slots, and honoring a pinned
 * provider. Drives a real AgentRuntime + InMemoryDatabaseAdapter with vi.fn
 * model handlers — no live model calls.
 */
import { describe, expect, it, vi } from "vitest";
import { InMemoryDatabaseAdapter } from "../../database/inMemoryAdapter";
import { ElizaError } from "../../errors";
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

	it("records the REAL provider that served the call for later stage recording (#13623)", async () => {
		const runtime = makeRuntime();
		const directApiOk = vi.fn(async () => "served-response");
		runtime.registerModel(ModelType.TEXT_LARGE, directApiOk, "anthropic", 100);

		// Before any call there is no resolved provider — undefined, not a
		// fabricated "default".
		expect(
			runtime.getLastResolvedModelProvider(ModelType.TEXT_LARGE),
		).toBeUndefined();

		await runtime.useModel(ModelType.TEXT_LARGE, { prompt: "hi" });
		expect(runtime.getLastResolvedModelProvider(ModelType.TEXT_LARGE)).toBe(
			"anthropic",
		);
	});

	it("records the provider that actually answered after a fallback rotation (#13623)", async () => {
		const runtime = makeRuntime();
		const primaryFails = vi.fn(async () => {
			throw statusError(429, "you have hit your session limit");
		});
		const backupOk = vi.fn(async () => "backup-response");
		runtime.registerModel(
			ModelType.TEXT_LARGE,
			primaryFails,
			"claude-sdk",
			100,
		);
		runtime.registerModel(ModelType.TEXT_LARGE, backupOk, "eliza-cloud", 10);

		await runtime.useModel(ModelType.TEXT_LARGE, { prompt: "hi" });
		// The provider that actually served (after failover) is recorded, not the
		// rate-limited primary.
		expect(runtime.getLastResolvedModelProvider(ModelType.TEXT_LARGE)).toBe(
			"eliza-cloud",
		);
	});
});

/**
 * Regression for the production incident: Anthropic's RESPONSE_HANDLER
 * exhausted its overload retries, the runtime failed over to the next
 * registered RESPONSE_HANDLER provider, and that provider was a keyless
 * plugin-openai (no OPENAI_API_KEY, not proxy mode). Its client construction
 * threw "OPENAI_API_KEY is required" as a BARE Error, which is not a
 * fallback-class error — so the failover chain rethrew and the whole turn died,
 * even though a healthy pooled ChatGPT/Codex handler (plugin-codex-cli leasing
 * an `openai-codex` subscription seat via the local codex-proxy Responses path)
 * was ALSO registered.
 *
 * The fix types that missing-credential throw as
 * `OPENAI_CREDENTIAL_UNAVAILABLE` so `isModelProviderFallbackError` classifies
 * it as fallback-class and `useModel` advances to the pooled openai-codex
 * handler. These tests are bidirectional: the typed error rotates to the pool
 * (post-fix), while a bare "OPENAI_API_KEY is required" Error still strands the
 * brain (reproduces the pre-fix failure), proving the classification — not the
 * message text — is what unblocks the pooled fallback.
 */
describe("AgentRuntime.useModel RESPONSE_HANDLER openai->openai-codex pool fallback (incident #27268)", () => {
	function anthropicOverload(): Error {
		return statusError(
			529,
			"API Error: 529 Overloaded. This is a server-side issue.",
		);
	}

	it("Anthropic overload -> keyless plugin-openai (typed) -> pooled openai-codex RESPONSE_HANDLER serves", async () => {
		const runtime = makeRuntime();

		// 1. Anthropic subscription RESPONSE_HANDLER, highest priority, overloaded.
		const anthropicFails = vi.fn(async () => {
			throw anthropicOverload();
		});
		// 2. plugin-openai RESPONSE_HANDLER with NO credential: it surfaces the
		//    typed OPENAI_CREDENTIAL_UNAVAILABLE that createOpenAIClient throws.
		const openaiKeyless = vi.fn(async () => {
			throw new ElizaError(
				"OPENAI_API_KEY is required. Set it in your environment variables or runtime settings.",
				{ code: "OPENAI_CREDENTIAL_UNAVAILABLE", severity: "ephemeral" },
			);
		});
		// 3. plugin-codex-cli RESPONSE_HANDLER: leases an openai-codex seat via the
		//    local codex-proxy Responses path. This is the pooled fallback target.
		const codexPooledOk = vi.fn(async () => "codex-pooled-response");

		runtime.registerModel(
			ModelType.RESPONSE_HANDLER,
			anthropicFails,
			"anthropic",
			100,
		);
		runtime.registerModel(
			ModelType.RESPONSE_HANDLER,
			openaiKeyless,
			"openai",
			50,
		);
		runtime.registerModel(
			ModelType.RESPONSE_HANDLER,
			codexPooledOk,
			"codex-cli",
			10,
		);

		await expect(
			runtime.useModel(ModelType.RESPONSE_HANDLER, { prompt: "hello" }),
		).resolves.toBe("codex-pooled-response");
		// All three were consulted in priority order; the pooled handler served.
		expect(anthropicFails).toHaveBeenCalledTimes(1);
		expect(openaiKeyless).toHaveBeenCalledTimes(1);
		expect(codexPooledOk).toHaveBeenCalledTimes(1);
		expect(
			runtime.getLastResolvedModelProvider(ModelType.RESPONSE_HANDLER),
		).toBe("codex-cli");
	});

	it("pre-fix repro: a BARE 'OPENAI_API_KEY is required' Error strands the brain (pool never reached)", async () => {
		const runtime = makeRuntime();
		const anthropicFails = vi.fn(async () => {
			throw anthropicOverload();
		});
		// The pre-fix throw: a plain Error, NOT typed. No rate-limit / 5xx /
		// timeout signal, so it is not fallback-class — the chain must rethrow.
		const openaiKeylessBare = vi.fn(async () => {
			throw new Error(
				"OPENAI_API_KEY is required. Set it in your environment variables or runtime settings.",
			);
		});
		const codexPooledOk = vi.fn(async () => "codex-pooled-response");

		runtime.registerModel(
			ModelType.RESPONSE_HANDLER,
			anthropicFails,
			"anthropic",
			100,
		);
		runtime.registerModel(
			ModelType.RESPONSE_HANDLER,
			openaiKeylessBare,
			"openai",
			50,
		);
		runtime.registerModel(
			ModelType.RESPONSE_HANDLER,
			codexPooledOk,
			"codex-cli",
			10,
		);

		await expect(
			runtime.useModel(ModelType.RESPONSE_HANDLER, { prompt: "hello" }),
		).rejects.toThrow("OPENAI_API_KEY is required");
		expect(anthropicFails).toHaveBeenCalledTimes(1);
		expect(openaiKeylessBare).toHaveBeenCalledTimes(1);
		// The pooled openai-codex handler is stranded behind the untyped throw.
		expect(codexPooledOk).not.toHaveBeenCalled();
	});

	it("fails closed: keyless plugin-openai is the LAST handler -> typed error still surfaces (no pool, no silent success)", async () => {
		const runtime = makeRuntime();
		const anthropicFails = vi.fn(async () => {
			throw anthropicOverload();
		});
		const openaiKeyless = vi.fn(async () => {
			throw new ElizaError(
				"OPENAI_API_KEY is required. Set it in your environment variables or runtime settings.",
				{ code: "OPENAI_CREDENTIAL_UNAVAILABLE", severity: "ephemeral" },
			);
		});

		runtime.registerModel(
			ModelType.RESPONSE_HANDLER,
			anthropicFails,
			"anthropic",
			100,
		);
		runtime.registerModel(
			ModelType.RESPONSE_HANDLER,
			openaiKeyless,
			"openai",
			50,
		);

		// No pooled handler registered: the classification never fabricates a
		// success, it just permits advancing. With nothing after it, the terminal
		// missing-credential error surfaces (fail-closed).
		await expect(
			runtime.useModel(ModelType.RESPONSE_HANDLER, { prompt: "hello" }),
		).rejects.toThrow("OPENAI_API_KEY is required");
		expect(anthropicFails).toHaveBeenCalledTimes(1);
		expect(openaiKeyless).toHaveBeenCalledTimes(1);
	});

	it("does NOT over-trigger: a real keyed OpenAI request error still classifies on its own signal", async () => {
		const runtime = makeRuntime();
		// A genuine OpenAI 400 (keyed, request-level) is NOT the missing-credential
		// path and must NOT be treated as fallback-class by the new code branch.
		const openaiBadRequest = vi.fn(async () => {
			throw statusError(400, "bad request: invalid tool schema");
		});
		const codexPooledOk = vi.fn(async () => "unused");

		runtime.registerModel(
			ModelType.RESPONSE_HANDLER,
			openaiBadRequest,
			"openai",
			50,
		);
		runtime.registerModel(
			ModelType.RESPONSE_HANDLER,
			codexPooledOk,
			"codex-cli",
			10,
		);

		await expect(
			runtime.useModel(ModelType.RESPONSE_HANDLER, { prompt: "hello" }),
		).rejects.toThrow("bad request");
		expect(openaiBadRequest).toHaveBeenCalledTimes(1);
		expect(codexPooledOk).not.toHaveBeenCalled();
	});
});
