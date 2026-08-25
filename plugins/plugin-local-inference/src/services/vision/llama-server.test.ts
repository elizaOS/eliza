import { describe, expect, it, vi } from "vitest";
import { createLlamaServerVisionBackend } from "./llama-server.ts";

function okFetch(body: unknown, opts: { status?: number } = {}) {
	return vi.fn(async () => ({
		ok: opts.status === undefined || (opts.status >= 200 && opts.status < 300),
		status: opts.status ?? 200,
		json: async () => body,
		text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
	}));
}

function bytesInput(data = "fake-image-bytes") {
	return {
		image: { kind: "bytes", bytes: Buffer.from(data), mimeType: "image/png" },
	};
}

describe("createLlamaServerVisionBackend", () => {
	it("requires a baseUrl", () => {
		expect(() => createLlamaServerVisionBackend({ baseUrl: "" })).toThrow(
			"baseUrl is required",
		);
	});

	it("strips a trailing slash from the baseUrl", async () => {
		const fetchImpl = okFetch({ content: "A photo of a cat." });
		const backend = createLlamaServerVisionBackend({
			baseUrl: "http://localhost:8080/",
			fetch: fetchImpl as never,
		});
		await backend.describe(bytesInput() as never);
		expect(fetchImpl.mock.calls[0][0]).toBe("http://localhost:8080/completion");
	});

	it("POSTs a base64 image_data body with the [img-12] prompt and defaults", async () => {
		const fetchImpl = okFetch({ content: "A photo of a cat." });
		const backend = createLlamaServerVisionBackend({
			baseUrl: "http://localhost:8080",
			fetch: fetchImpl as never,
		});
		await backend.describe(bytesInput() as never);
		const [url, init] = fetchImpl.mock.calls[0];
		expect(url).toBe("http://localhost:8080/completion");
		expect(init.method).toBe("POST");
		expect(init.headers["content-type"]).toBe("application/json");
		expect(init.headers["x-image-mime"]).toBe("image/png");
		const body = JSON.parse(init.body);
		expect(body.prompt).toContain("[img-12]");
		expect(body.prompt).toContain("Describe what is in this image.");
		expect(body.image_data).toEqual([
			{ data: Buffer.from("fake-image-bytes").toString("base64"), id: 12 },
		]);
		expect(body.n_predict).toBe(256);
		expect(body.temperature).toBe(0.2);
		expect(body.stream).toBe(false);
		expect(body.cache_prompt).toBe(false);
	});

	it("honors custom maxTokens, temperature, and prompt, and passes the signal through", async () => {
		const fetchImpl = okFetch({ content: "A photo of a cat." });
		const backend = createLlamaServerVisionBackend({
			baseUrl: "http://localhost:8080",
			fetch: fetchImpl as never,
		});
		const controller = new AbortController();
		await backend.describe({
			...bytesInput(),
			prompt: "  What breed?  ",
			maxTokens: 64,
			temperature: 0.9,
			signal: controller.signal,
		} as never);
		const [, init] = fetchImpl.mock.calls[0];
		const body = JSON.parse(init.body);
		expect(body.n_predict).toBe(64);
		expect(body.temperature).toBe(0.9);
		expect(body.prompt).toContain("What breed?");
		expect(init.signal).toBe(controller.signal);
	});

	it("shapes a successful response into a VisionDescribeResult", async () => {
		const fetchImpl = okFetch({
			content: "A photo of a cat.",
			timings: { prompt_ms: 180.4, predicted_ms: 423.1 },
		});
		const backend = createLlamaServerVisionBackend({
			baseUrl: "http://localhost:8080",
			fetch: fetchImpl as never,
		});
		const result = await backend.describe(bytesInput() as never);
		expect(result.title).toBe("A photo of a cat");
		expect(result.description).toBe("A photo of a cat.");
		expect(result.projectorMs).toBe(180.4);
		expect(result.decodeMs).toBe(423.1);
		expect(result.cacheHit).toBe(false);
	});

	it("throws with the server status and truncated body on a non-ok response", async () => {
		const fetchImpl = okFetch("bad gateway", { status: 502 });
		const backend = createLlamaServerVisionBackend({
			baseUrl: "http://localhost:8080",
			fetch: fetchImpl as never,
		});
		await expect(backend.describe(bytesInput() as never)).rejects.toThrow(
			/502/,
		);
		await expect(backend.describe(bytesInput() as never)).rejects.toThrow(
			/bad gateway/,
		);
	});

	it("throws when the response is missing a string content field", async () => {
		const backend = createLlamaServerVisionBackend({
			baseUrl: "http://localhost:8080",
			fetch: okFetch({ timings: {} }) as never,
		});
		await expect(backend.describe(bytesInput() as never)).rejects.toThrow(
			"missing string `content`",
		);
	});

	it("rejects a non-string content field", async () => {
		const backend = createLlamaServerVisionBackend({
			baseUrl: "http://localhost:8080",
			fetch: okFetch({ content: 42 }) as never,
		});
		await expect(backend.describe(bytesInput() as never)).rejects.toThrow(
			"missing string `content`",
		);
	});

	it("rejects an empty/whitespace completion text", async () => {
		const backend = createLlamaServerVisionBackend({
			baseUrl: "http://localhost:8080",
			fetch: okFetch({ content: "   \n  " }) as never,
		});
		await expect(backend.describe(bytesInput() as never)).rejects.toThrow(
			"empty text",
		);
	});

	it("derives the title from the first sentence", async () => {
		const backend = createLlamaServerVisionBackend({
			baseUrl: "http://localhost:8080",
			fetch: okFetch({ content: "A red car. A blue truck." }) as never,
		});
		const result = await backend.describe(bytesInput() as never);
		expect(result.title).toBe("A red car");
	});

	it("falls back to the full text when there is no sentence punctuation", async () => {
		const backend = createLlamaServerVisionBackend({
			baseUrl: "http://localhost:8080",
			fetch: okFetch({ content: "blurry image" }) as never,
		});
		const result = await backend.describe(bytesInput() as never);
		expect(result.title).toBe("blurry image");
	});

	it("uses the Image placeholder when text starts with punctuation", async () => {
		const backend = createLlamaServerVisionBackend({
			baseUrl: "http://localhost:8080",
			fetch: okFetch({ content: ".hidden leading punctuation" }) as never,
		});
		const result = await backend.describe(bytesInput() as never);
		expect(result.title).toBe("Image");
	});

	it("propagates an aborted fetch as-is", async () => {
		const abortError = new DOMException(
			"The operation was aborted",
			"AbortError",
		);
		const fetchImpl = vi.fn(async () => {
			throw abortError;
		});
		const backend = createLlamaServerVisionBackend({
			baseUrl: "http://localhost:8080",
			fetch: fetchImpl as never,
		});
		await expect(backend.describe(bytesInput() as never)).rejects.toThrow(
			"The operation was aborted",
		);
	});

	it("clears its baseUrl on dispose", async () => {
		const fetchImpl = okFetch({ content: "x" });
		const backend = createLlamaServerVisionBackend({
			baseUrl: "http://localhost:8080",
			fetch: fetchImpl as never,
		});
		await backend.dispose();
		await backend.describe(bytesInput() as never);
		// baseUrl was dropped, so a late call must not hit the old endpoint.
		expect(fetchImpl.mock.calls[0][0]).toBe("/completion");
	});
});
