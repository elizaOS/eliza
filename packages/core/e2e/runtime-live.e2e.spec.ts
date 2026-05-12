/**
 * Full end-to-end tests for the AgentRuntime.
 *
 * These tests start a real AgentRuntime backed by a live LLM provider
 * (OpenAI, Anthropic, Google, or Ollama) and verify that real inference
 * results are returned through a lightweight HTTP test harness.
 *
 * Prerequisites:
 *   - At least one LLM provider configured (OPENAI_API_KEY, ANTHROPIC_API_KEY, etc.)
 *   - OR a running Ollama instance
 */
import { expect, test } from "@playwright/test";

const isPlaywrightE2E = process.env.ELIZA_PLAYWRIGHT_E2E === "1";

if (isPlaywrightE2E) {
	// Skip the entire suite when no provider is available (set by global-setup).
	test.beforeEach(() => {
		test.skip(
			process.env.__E2E_SKIP__ === "1",
			"No inference provider available",
		);
	});

	// ─── Health & status ──────────────────────────────────────────────────────

	test("GET /health returns 200", async ({ request }) => {
		const res = await request.get("/health");
		expect(res.status()).toBe(200);
		const body = await res.json();
		expect(body.ok).toBe(true);
	});

	test("GET /status returns agent info", async ({ request }) => {
		const res = await request.get("/status");
		expect(res.status()).toBe(200);

		const body = await res.json();
		expect(body.agentId).toBeTruthy();
		expect(body.name).toBe("E2ETestAgent");
		expect(body.provider).toBeTruthy();
		expect(body.ready).toBe(true);
	});

	// ─── Chat: simple question ────────────────────────────────────────────────

	test("POST /chat with a simple math question returns a real answer", async ({
		request,
	}) => {
		const res = await request.post("/chat", {
			data: { text: "What is 2+2? Reply with just the number." },
		});
		expect(res.status()).toBe(200);

		const body = await res.json();
		expect(body.text).toBeTruthy();
		expect(typeof body.text).toBe("string");
		// The response should mention "4" somewhere
		expect(body.text).toContain("4");
	});

	// ─── Chat: longer creative response ──────────────────────────────────────

	test("POST /chat with a creative prompt returns substantial text", async ({
		request,
	}) => {
		const res = await request.post("/chat", {
			data: { text: "Write a haiku about software testing." },
		});
		expect(res.status()).toBe(200);

		const body = await res.json();
		expect(body.text).toBeTruthy();
		// A haiku is at least 20 characters
		expect(body.text.length).toBeGreaterThan(20);
	});

	// ─── Chat: knowledge / factual ───────────────────────────────────────────

	test("POST /chat with a factual question returns accurate data", async ({
		request,
	}) => {
		const res = await request.post("/chat", {
			data: {
				text: "What is the capital of France? Reply in one word.",
			},
		});
		expect(res.status()).toBe(200);

		const body = await res.json();
		expect(body.text).toBeTruthy();
		expect(body.text.toLowerCase()).toContain("paris");
	});

	// ─── Character system prompt respected ────────────────────────────────────

	test("agent respects its system prompt (concise answers)", async ({
		request,
	}) => {
		const res = await request.post("/chat", {
			data: {
				text: "Explain quantum computing.",
			},
		});
		expect(res.status()).toBe(200);

		const body = await res.json();
		expect(body.text).toBeTruthy();
		// System prompt says "Keep answers short (1-3 sentences)".
		// We verify the response is not excessively long (< 1500 chars is reasonable).
		expect(body.text.length).toBeLessThan(1500);
		expect(body.text.length).toBeGreaterThan(10);
	});

	// ─── Error handling ──────────────────────────────────────────────────────

	test("POST /chat with empty text returns 400", async ({ request }) => {
		const res = await request.post("/chat", {
			data: { text: "" },
		});
		expect(res.status()).toBe(400);

		const body = await res.json();
		expect(body.error).toBeTruthy();
	});

	test("POST /chat with missing text field returns 400", async ({
		request,
	}) => {
		const res = await request.post("/chat", {
			data: {},
		});
		expect(res.status()).toBe(400);

		const body = await res.json();
		expect(body.error).toBeTruthy();
	});

	// ─── 404 fallback ────────────────────────────────────────────────────────

	test("GET /nonexistent returns 404", async ({ request }) => {
		const res = await request.get("/nonexistent");
		expect(res.status()).toBe(404);
	});
}
