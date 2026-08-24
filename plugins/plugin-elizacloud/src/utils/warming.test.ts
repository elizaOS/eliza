/**
 * Tests for `warmingRetryWaitSeconds` — cloud cache-warming 503 detection.
 *
 * Core contract: only the gateway's explicit warming shape earns a retry
 * wait; every other status or body yields null so callers fail fast. A
 * warming 503 must survive a body peek (clone) so the caller can still
 * consume the response, and retryAfter is clamped to the 3s ceiling with a
 * 1.5s default.
 */

import { describe, expect, it } from "vitest";
import { warmingRetryWaitSeconds } from "./warming";

function jsonResponse(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

describe("warmingRetryWaitSeconds", () => {
	it("returns null for non-503 statuses", async () => {
		const resp = jsonResponse(500, { error: { code: "internal" } });
		expect(await warmingRetryWaitSeconds(resp)).toBeNull();
	});

	it("returns null for a 503 without a warming shape", async () => {
		const resp = jsonResponse(503, { error: { code: "rate_limited" } });
		expect(await warmingRetryWaitSeconds(resp)).toBeNull();
	});

	it("recognizes a top-level _cache_warming code", async () => {
		const resp = jsonResponse(503, { code: "model_cache_warming" });
		expect(await warmingRetryWaitSeconds(resp)).toBe(1.5);
	});

	it("recognizes an error-nested _cache_warming code", async () => {
		const resp = jsonResponse(503, {
			error: { code: "admission_cache_warming" },
		});
		expect(await warmingRetryWaitSeconds(resp)).toBe(1.5);
	});

	it("recognizes service_unavailable as a warming shape", async () => {
		const codeResp = jsonResponse(503, { error: { code: "service_unavailable" } });
		expect(await warmingRetryWaitSeconds(codeResp)).toBe(1.5);

		const typeResp = jsonResponse(503, { error: { type: "service_unavailable" } });
		expect(await warmingRetryWaitSeconds(typeResp)).toBe(1.5);
	});

	it("respects a positive retryAfter under the ceiling", async () => {
		const resp = jsonResponse(503, {
			error: { code: "model_cache_warming", retryAfter: 2 },
		});
		expect(await warmingRetryWaitSeconds(resp)).toBe(2);
	});

	it("clamps retryAfter to the 3s ceiling", async () => {
		const resp = jsonResponse(503, {
			error: { code: "model_cache_warming", retryAfter: 30 },
		});
		expect(await warmingRetryWaitSeconds(resp)).toBe(3);
	});

	it("falls back to 1.5s for zero or invalid retryAfter", async () => {
		const zero = jsonResponse(503, {
			error: { code: "model_cache_warming", retryAfter: 0 },
		});
		expect(await warmingRetryWaitSeconds(zero)).toBe(1.5);

		const negative = jsonResponse(503, {
			error: { code: "model_cache_warming", retryAfter: -5 },
		});
		expect(await warmingRetryWaitSeconds(negative)).toBe(1.5);

		const nan = jsonResponse(503, {
			error: { code: "model_cache_warming", retryAfter: NaN },
		});
		expect(await warmingRetryWaitSeconds(nan)).toBe(1.5);
	});

	it("reads the body via a clone, leaving the caller's body intact", async () => {
		const resp = jsonResponse(503, { error: { code: "model_cache_warming" } });
		const wait = await warmingRetryWaitSeconds(resp);

		expect(wait).toBe(1.5);
		// The caller can still consume the original body.
		const body = (await resp.json()) as { error: { code: string } };
		expect(body.error.code).toBe("model_cache_warming");
	});

	it("returns null for a non-JSON 503 body", async () => {
		const resp = new Response("<html>Service Unavailable</html>", {
			status: 503,
			headers: { "content-type": "text/html" },
		});
		expect(await warmingRetryWaitSeconds(resp)).toBeNull();
	});

	it("returns null for an empty 503 body", async () => {
		const resp = new Response("", { status: 503 });
		expect(await warmingRetryWaitSeconds(resp)).toBeNull();
	});
});
