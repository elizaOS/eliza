/**
 * Unit tests for inference-provider detection in `@elizaos/core/testing`.
 *
 * The real module is driven end to end; only the process boundary is controlled:
 * `fetch` is stubbed so Ollama probing is deterministic (a live daemon on the
 * machine would otherwise decide the result), and every credential/gateway env
 * var the detector reads is saved and restored around each case. `OLLAMA_URL`
 * is read once at module load, so the module is imported dynamically after
 * pinning it.
 */
import {
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";

const OLLAMA_TEST_URL = "http://127.0.0.1:41234";

const MANAGED_ENV_KEYS = [
	"OPENAI_API_KEY",
	"CEREBRAS_API_KEY",
	"ANTHROPIC_API_KEY",
	"GROQ_API_KEY",
	"GOOGLE_API_KEY",
	"GOOGLE_AI_API_KEY",
	"ELIZA_MODEL_GATEWAY_URL",
	"ELIZA_MODEL_GATEWAY_TOKEN",
	"ELIZA_MODEL_GATEWAY_STRICT",
	"OPENAI_BASE_URL",
	"OLLAMA_URL",
] as const;

let savedEnv: Record<string, string | undefined>;
let mod: typeof import("./inference-provider.ts");

function stubFetch(handler: () => Promise<Response>): ReturnType<typeof vi.fn> {
	const fetchMock = vi.fn(handler);
	vi.stubGlobal("fetch", fetchMock);
	return fetchMock;
}

function ollamaTagsResponse(payload: unknown): Response {
	return new Response(JSON.stringify(payload), { status: 200 });
}

function findProvider(
	result: Awaited<ReturnType<typeof mod.detectInferenceProviders>>,
	name: string,
) {
	return result.allProviders.find((p) => p.name === name);
}

async function detectWithOllama(
	handler: () => Promise<Response>,
): Promise<Awaited<ReturnType<typeof mod.detectInferenceProviders>>> {
	stubFetch(handler);
	return mod.detectInferenceProviders();
}

beforeAll(async () => {
	process.env.OLLAMA_URL = OLLAMA_TEST_URL;
	mod = await import("./inference-provider.ts");
});

beforeEach(() => {
	savedEnv = {};
	for (const key of MANAGED_ENV_KEYS) {
		savedEnv[key] = process.env[key];
		delete process.env[key];
	}
	process.env.OLLAMA_URL = OLLAMA_TEST_URL;
});

afterEach(() => {
	vi.unstubAllGlobals();
	for (const key of MANAGED_ENV_KEYS) {
		const value = savedEnv[key];
		if (value === undefined) {
			delete process.env[key];
		} else {
			process.env[key] = value;
		}
	}
});

describe("inference-provider", () => {
	describe("cloud provider detection", () => {
		it("marks every cloud provider unavailable with a not-set error when no keys exist", async () => {
			const result = await detectWithOllama(async () => {
				throw new Error("connection refused");
			});

			expect(result.allProviders).toHaveLength(5);
			expect(findProvider(result, "openai")).toEqual({
				name: "openai",
				available: false,
				error: "OPENAI_API_KEY or CEREBRAS_API_KEY not set",
			});
			expect(findProvider(result, "anthropic")?.error).toBe(
				"ANTHROPIC_API_KEY not set",
			);
			expect(findProvider(result, "groq")?.error).toBe("GROQ_API_KEY not set");
			expect(findProvider(result, "google")?.error).toBe(
				"GOOGLE_API_KEY or GOOGLE_AI_API_KEY not set",
			);
		});

		it("treats a whitespace-only key as unset", async () => {
			process.env.OPENAI_API_KEY = "   ";

			const result = await detectWithOllama(async () => {
				throw new Error("connection refused");
			});

			expect(result.hasProvider).toBe(false);
			expect(findProvider(result, "openai")?.available).toBe(false);
		});

		it("prefers OPENAI_API_KEY when both OpenAI credentials are present and keeps the default endpoint", async () => {
			process.env.OPENAI_API_KEY = "sk-test";
			process.env.CEREBRAS_API_KEY = "csk-test";

			const result = await detectWithOllama(async () => {
				throw new Error("connection refused");
			});

			const openai = findProvider(result, "openai");
			expect(openai).toEqual({
				name: "openai",
				available: true,
				endpoint: "https://api.openai.com/v1",
			});
		});

		it("routes Cerebras-only credentials to the Cerebras endpoint", async () => {
			process.env.CEREBRAS_API_KEY = "csk-test";

			const result = await detectWithOllama(async () => {
				throw new Error("connection refused");
			});

			expect(findProvider(result, "openai")).toEqual({
				name: "openai",
				available: true,
				endpoint: "https://api.cerebras.ai/v1",
			});
		});

		it("honours OPENAI_BASE_URL for Cerebras-only credentials", async () => {
			process.env.CEREBRAS_API_KEY = "csk-test";
			process.env.OPENAI_BASE_URL = "  http://proxy.test/v1  ";

			const result = await detectWithOllama(async () => {
				throw new Error("connection refused");
			});

			expect(findProvider(result, "openai")).toEqual({
				name: "openai",
				available: true,
				endpoint: "http://proxy.test/v1",
			});
		});

		it("uses the model gateway URL for OpenAI when gateway mode is on", async () => {
			process.env.OPENAI_API_KEY = "sk-test";
			process.env.ELIZA_MODEL_GATEWAY_URL = "http://gateway.test/v1";
			process.env.ELIZA_MODEL_GATEWAY_TOKEN = "gw-token";

			const result = await detectWithOllama(async () => {
				throw new Error("connection refused");
			});

			expect(findProvider(result, "openai")).toEqual({
				name: "openai",
				available: true,
				endpoint: "http://gateway.test/v1",
			});
		});

		it("does not crash detection when strict gateway mode throws on a raw key", async () => {
			process.env.OPENAI_API_KEY = "sk-test";
			process.env.ELIZA_MODEL_GATEWAY_URL = "http://gateway.test/v1";
			process.env.ELIZA_MODEL_GATEWAY_STRICT = "true";

			const result = await detectWithOllama(async () => {
				throw new Error("connection refused");
			});

			expect(findProvider(result, "openai")).toEqual({
				name: "openai",
				available: true,
				endpoint: "http://gateway.test/v1",
			});
			expect(result.hasProvider).toBe(true);
		});

		it("maps non-OpenAI providers to their fixed endpoints and ignores the gateway override for them", async () => {
			process.env.ANTHROPIC_API_KEY = "ak-test";
			process.env.GROQ_API_KEY = "gk-test";
			process.env.GOOGLE_AI_API_KEY = "ggk-test";
			process.env.ELIZA_MODEL_GATEWAY_URL = "http://gateway.test/v1";

			const result = await detectWithOllama(async () => {
				throw new Error("connection refused");
			});

			expect(findProvider(result, "anthropic")).toEqual({
				name: "anthropic",
				available: true,
				endpoint: "https://api.anthropic.com",
			});
			expect(findProvider(result, "groq")).toEqual({
				name: "groq",
				available: true,
				endpoint: "https://api.groq.com/openai/v1",
			});
			expect(findProvider(result, "google")).toEqual({
				name: "google",
				available: true,
				endpoint: "https://generativelanguage.googleapis.com",
			});
		});
	});

	describe("ollama probing", () => {
		it("hits the tags endpoint with GET and an abort signal, then lists model names", async () => {
			const fetchMock = stubFetch(async () =>
				ollamaTagsResponse({
					models: [{ name: "eliza-1-2b" }, { name: "llama3" }],
				}),
			);

			const result = await mod.detectInferenceProviders();
			const ollama = findProvider(result, "ollama");

			const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
			expect(url).toBe(`${OLLAMA_TEST_URL}/api/tags`);
			expect(init.method).toBe("GET");
			expect(init.signal).toBeInstanceOf(AbortSignal);

			expect(ollama).toEqual({
				name: "ollama",
				available: true,
				endpoint: OLLAMA_TEST_URL,
				models: ["eliza-1-2b", "llama3"],
			});
		});

		it("reports an empty model list when the tags payload has no models field", async () => {
			const result = await detectWithOllama(async () => ollamaTagsResponse({}));

			expect(findProvider(result, "ollama")).toEqual({
				name: "ollama",
				available: true,
				endpoint: OLLAMA_TEST_URL,
				models: [],
			});
		});

		it("rejects a malformed tags payload instead of reporting availability", async () => {
			const result = await detectWithOllama(async () =>
				ollamaTagsResponse({ models: [{ name: 42 }] }),
			);

			const ollama = findProvider(result, "ollama");
			expect(ollama?.available).toBe(false);
			expect(ollama?.error).toMatch(/^Invalid response from Ollama:/);
		});

		it("reports the HTTP status when the tags endpoint fails", async () => {
			const result = await detectWithOllama(
				async () => new Response("nope", { status: 503 }),
			);

			expect(findProvider(result, "ollama")).toEqual({
				name: "ollama",
				available: false,
				endpoint: OLLAMA_TEST_URL,
				error: "Ollama returned status 503",
			});
		});

		it("survives a network failure and carries the error message", async () => {
			const result = await detectWithOllama(async () => {
				throw new Error("connection refused");
			});

			expect(findProvider(result, "ollama")?.error).toBe("connection refused");
		});

		it("falls back to 'Unknown error' for non-Error rejections", async () => {
			const result = await detectWithOllama(async () => {
				throw "not-an-error-object";
			});

			expect(findProvider(result, "ollama")?.error).toBe("Unknown error");
		});
	});

	describe("detection aggregation", () => {
		it("reports no provider and a recovery summary when everything is down", async () => {
			const result = await detectWithOllama(async () => {
				throw new Error("connection refused");
			});

			expect(result.hasProvider).toBe(false);
			expect(result.primaryProvider).toBeNull();
			expect(result.summary).toContain("NO INFERENCE PROVIDER AVAILABLE");
		});

		it("lets Ollama become primary when no cloud key is configured", async () => {
			const result = await detectWithOllama(async () =>
				ollamaTagsResponse({ models: [{ name: "m" }] }),
			);

			expect(result.hasProvider).toBe(true);
			expect(result.primaryProvider?.name).toBe("ollama");
			expect(result.summary).toContain("Using inference provider: OLLAMA");
			expect(result.summary).toContain("- OLLAMA");
			expect(result.summary).toContain("- 1 models");
		});

		it("prefers the first available cloud provider over Ollama", async () => {
			process.env.ANTHROPIC_API_KEY = "ak-test";
			process.env.GROQ_API_KEY = "gk-test";

			const result = await detectWithOllama(async () =>
				ollamaTagsResponse({ models: [] }),
			);

			expect(result.hasProvider).toBe(true);
			expect(result.primaryProvider?.name).toBe("anthropic");
			expect(result.summary).toContain("Using inference provider: ANTHROPIC");
			expect(result.summary).toContain("(https://api.anthropic.com)");
		});

		it("lists every available provider with its endpoint in the summary", async () => {
			process.env.OPENAI_API_KEY = "sk-test";
			process.env.GROQ_API_KEY = "gk-test";

			const result = await detectWithOllama(async () => {
				throw new Error("connection refused");
			});

			expect(result.summary).toContain("Using inference provider: OPENAI");
			expect(result.summary).toContain("- OPENAI (https://api.openai.com/v1)");
			expect(result.summary).toContain(
				"- GROQ (https://api.groq.com/openai/v1)",
			);
			expect(result.summary).not.toContain("OLLAMA");
		});
	});

	describe("requireInferenceProvider", () => {
		it("throws actionable guidance when no provider exists", async () => {
			stubFetch(async () => {
				throw new Error("connection refused");
			});

			await expect(mod.requireInferenceProvider()).rejects.toThrow(
				/No inference provider available/,
			);
		});

		it("resolves the primary provider when one is available", async () => {
			process.env.ANTHROPIC_API_KEY = "ak-test";

			stubFetch(async () => {
				throw new Error("connection refused");
			});

			await expect(mod.requireInferenceProvider()).resolves.toEqual({
				name: "anthropic",
				available: true,
				endpoint: "https://api.anthropic.com",
			});
		});
	});

	describe("hasInferenceProvider", () => {
		it("returns false when nothing is configured or reachable", async () => {
			stubFetch(async () => {
				throw new Error("connection refused");
			});

			await expect(mod.hasInferenceProvider()).resolves.toBe(false);
		});

		it("returns true when any cloud key satisfies detection", async () => {
			process.env.GOOGLE_API_KEY = "gk-test";

			stubFetch(async () => {
				throw new Error("connection refused");
			});

			await expect(mod.hasInferenceProvider()).resolves.toBe(true);
		});
	});
});
