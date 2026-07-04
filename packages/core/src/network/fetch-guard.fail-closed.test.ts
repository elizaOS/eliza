/**
 * Fail-closed contract for the SSRF fetch guard when its pinned DNS transport
 * module cannot be imported on Node: the guard rejects every guarded fetch
 * rather than downgrade to the unpinned path. Deterministic — import mocked to throw.
 */
import { describe, expect, it, vi } from "vitest";
import { fetchWithSsrfGuard } from "./fetch-guard.ts";

// Simulate a packaging/import failure of the pinned transport module. On a
// Node-like runtime the guard must fail CLOSED (reject the guarded fetch)
// instead of silently reverting to the racy unpinned path.
vi.mock("./node-pinned-fetch.js", () => {
	throw new Error("simulated packaging failure");
});

describe("fetchWithSsrfGuard when the pinned transport cannot load (Node runtime)", () => {
	it("fails closed instead of falling back to unpinned fetch", async () => {
		await expect(
			fetchWithSsrfGuard({ url: "https://example.com/resource" }),
		).rejects.toThrow(/pinned DNS transport .* failed to load/i);
	});

	it("keeps failing closed on subsequent guarded fetches (no poisoned success)", async () => {
		await expect(
			fetchWithSsrfGuard({ url: "https://example.org/first" }),
		).rejects.toThrow(/Refusing to fall back to unpinned fetch/i);
		await expect(
			fetchWithSsrfGuard({ url: "https://example.org/other" }),
		).rejects.toThrow(/Refusing to fall back to unpinned fetch/i);
	});

	it("still honors an explicitly provided fetchImpl (caller opted out of node defaults)", async () => {
		const fetchImpl = vi.fn(async () => new Response("ok", { status: 200 }));
		const { response, release } = await fetchWithSsrfGuard({
			url: "https://example.com/page",
			fetchImpl,
		});
		expect(response.status).toBe(200);
		expect(fetchImpl).toHaveBeenCalledTimes(1);
		await release();
	});
});
