import { afterEach, describe, expect, it, vi } from "vitest";
import {
	detectLocalLlmBackends,
	getOllamaProbeBaseUrl,
	resolveOpenAiCompatibleModelsUrl,
} from "../testing/local-llm-backends";

describe("local-llm-backends", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	describe("resolveOpenAiCompatibleModelsUrl", () => {
		it("appends /v1/models to server root", () => {
			expect(resolveOpenAiCompatibleModelsUrl("http://localhost:1234")).toBe(
				"http://localhost:1234/v1/models",
			);
		});

		it("reuses /v1 when base already ends with /v1", () => {
			expect(resolveOpenAiCompatibleModelsUrl("http://x:1/v1")).toBe(
				"http://x:1/v1/models",
			);
		});

		it("trims trailing slashes before resolving", () => {
			expect(resolveOpenAiCompatibleModelsUrl("http://host:9///")).toBe(
				"http://host:9/v1/models",
			);
		});
	});

	describe("getOllamaProbeBaseUrl", () => {
		it("prefers OLLAMA_BASE_URL over OLLAMA_URL", () => {
			expect(
				getOllamaProbeBaseUrl({
					OLLAMA_BASE_URL: "http://a:1",
					OLLAMA_URL: "http://b:2",
				}),
			).toBe("http://a:1");
		});
	});

	describe("detectLocalLlmBackends", () => {
		it("parses Ollama tags and OpenAI-compatible model lists", async () => {
			vi.stubGlobal(
				"fetch",
				vi.fn(async (input: RequestInfo | URL) => {
					const u = String(input);
					if (u.endsWith("/api/tags")) {
						return new Response(
							JSON.stringify({ models: [{ name: "phi3:mini" }] }),
							{ status: 200 },
						);
					}
					if (u.includes(":1234/v1/models")) {
						return new Response(
							JSON.stringify({ data: [{ id: "qwen2.5-7b" }] }),
							{ status: 200 },
						);
					}
					if (u.includes(":8000/v1/models")) {
						return new Response(JSON.stringify({ data: [{ id: "meta-llama/Llama-3-8B" }] }), {
							status: 200,
						});
					}
					return new Response("not found", { status: 404 });
				}),
			);

			const env = {
				OLLAMA_BASE_URL: "http://127.0.0.1:11434",
				LM_STUDIO_BASE_URL: "http://127.0.0.1:1234",
				VLLM_BASE_URL: "http://127.0.0.1:8000",
			};

			const backends = await detectLocalLlmBackends({ env });

			expect(backends.find((b) => b.id === "ollama")).toMatchObject({
				reachable: true,
				hasDownloadedModels: true,
				models: ["phi3:mini"],
			});
			expect(backends.find((b) => b.id === "lmstudio")).toMatchObject({
				reachable: true,
				hasDownloadedModels: true,
				models: ["qwen2.5-7b"],
			});
			expect(backends.find((b) => b.id === "vllm")).toMatchObject({
				reachable: true,
				hasDownloadedModels: true,
				models: ["meta-llama/Llama-3-8B"],
			});
		});
	});
});
