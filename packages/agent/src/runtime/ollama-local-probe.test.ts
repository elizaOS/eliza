import { afterEach, describe, expect, it, vi } from "vitest";
import { maybeEnableOllamaFromLocalProbe } from "./ollama-local-probe.js";

describe("maybeEnableOllamaFromLocalProbe", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	it("does nothing when OLLAMA_BASE_URL is already set", async () => {
		vi.stubGlobal("fetch", vi.fn());
		const env = {
			OLLAMA_BASE_URL: "http://custom:11434",
		} as NodeJS.ProcessEnv;
		await maybeEnableOllamaFromLocalProbe(env);
		expect(env.OLLAMA_BASE_URL).toBe("http://custom:11434");
		expect(fetch).not.toHaveBeenCalled();
	});

	it("does nothing when ELIZA_SKIP_LOCAL_OLLAMA_PROBE=1", async () => {
		vi.stubGlobal("fetch", vi.fn());
		const env = {
			ELIZA_SKIP_LOCAL_OLLAMA_PROBE: "1",
		} as NodeJS.ProcessEnv;
		await maybeEnableOllamaFromLocalProbe(env);
		expect(fetch).not.toHaveBeenCalled();
	});

	it("sets OLLAMA_BASE_URL when probe returns models", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string | URL) => {
				expect(String(url)).toContain("/api/tags");
				return new Response(JSON.stringify({ models: [{ name: "a" }] }), {
					status: 200,
				});
			}),
		);
		const env = {} as NodeJS.ProcessEnv;
		await maybeEnableOllamaFromLocalProbe(env);
		expect(env.OLLAMA_BASE_URL).toBe("http://127.0.0.1:11434");
	});

	it("does not set env when Ollama returns zero models", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				return new Response(JSON.stringify({ models: [] }), { status: 200 });
			}),
		);
		const env = {} as NodeJS.ProcessEnv;
		await maybeEnableOllamaFromLocalProbe(env);
		expect(env.OLLAMA_BASE_URL).toBeUndefined();
	});
});
