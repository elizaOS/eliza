/**
 * Exercises one live-provider round trip through the real runtime message loop.
 * The HTTP server is test transport; product ingress and validation belong to
 * the agent host suites. A fresh marker distinguishes this response from a
 * canned readiness reply without treating model trivia as a runtime contract.
 */
import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";

if (process.env.ELIZA_PLAYWRIGHT_E2E === "1") {
	test("delivers a live runtime response to the current message", async ({
		request,
	}) => {
		test.skip(
			process.env.__E2E_SKIP__ === "1",
			"No inference provider available",
		);
		const marker = `runtime-smoke-${randomUUID()}`;
		const response = await request.post("/chat", {
			data: { text: `Reply with this exact marker: ${marker}` },
		});
		expect(response.status()).toBe(200);
		const body = await response.json();
		expect(body.text).toContain(marker);
	});
}
