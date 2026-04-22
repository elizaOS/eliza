import { afterEach, describe, expect, it, vi } from "vitest";
import { maybeEnableOpenAiCompatibleFromLocalProbe } from "./openai-compatible-local-probe.js";

describe("maybeEnableOpenAiCompatibleFromLocalProbe", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	it("does nothing when OPENAI_BASE_URL is already set", async () => {
		vi.stubGlobal("fetch", vi.fn());
		const env = {
			OPENAI_BASE_URL: "http://custom:1234/v1",
		} as NodeJS.ProcessEnv;
		await maybeEnableOpenAiCompatibleFromLocalProbe(env);
		expect(fetch).not.toHaveBeenCalled();
	});

	it("does nothing when OPENAI_API_KEY is already set (OpenAI cloud path)", async () => {
		vi.stubGlobal("fetch", vi.fn());
		const env = {
			OPENAI_API_KEY: "sk-real",
		} as NodeJS.ProcessEnv;
		await maybeEnableOpenAiCompatibleFromLocalProbe(env);
		expect(fetch).not.toHaveBeenCalled();
	});

	it("does nothing when ELIZA_SKIP_LOCAL_OPENAI_COMPAT_PROBE=1", async () => {
		vi.stubGlobal("fetch", vi.fn());
		const env = {
			ELIZA_SKIP_LOCAL_OPENAI_COMPAT_PROBE: "1",
		} as NodeJS.ProcessEnv;
		await maybeEnableOpenAiCompatibleFromLocalProbe(env);
		expect(fetch).not.toHaveBeenCalled();
	});

	it("sets OPENAI_BASE_URL + placeholder key when LM Studio /v1/models returns models", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string | URL) => {
				const s = String(url);
				if (s.includes(":1234") && s.endsWith("/models")) {
					return new Response(JSON.stringify({ data: [{ id: "qwen" }] }), {
						status: 200,
					});
				}
				return new Response("", { status: 404 });
			}),
		);
		const env = {} as NodeJS.ProcessEnv;
		await maybeEnableOpenAiCompatibleFromLocalProbe(env);
		expect(env.OPENAI_BASE_URL).toBe("http://127.0.0.1:1234/v1");
		expect(env.OPENAI_API_KEY).toBe("lm-studio");
	});

	it("does not set env when /v1/models returns empty data", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				return new Response(JSON.stringify({ data: [] }), { status: 200 });
			}),
		);
		const env = {} as NodeJS.ProcessEnv;
		await maybeEnableOpenAiCompatibleFromLocalProbe(env);
		expect(env.OPENAI_BASE_URL).toBeUndefined();
		expect(env.OPENAI_API_KEY).toBeUndefined();
	});
});
