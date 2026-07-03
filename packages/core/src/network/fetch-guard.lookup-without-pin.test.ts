import { describe, expect, it, vi } from "vitest";
import { fetchWithSsrfGuard } from "./fetch-guard.ts";
import type { LookupFn, PinnedLookupFetchLike } from "./ssrf.ts";

// L8 (#12229): a `lookupFn` computes a DNS pin, but without a `pinnedFetchImpl`
// to connect to that pinned IP the request would fall through to the unpinned
// fetcher — the pin is computed and silently discarded, re-opening the
// DNS-rebinding race (#11147). The guard must throw instead of downgrading.
describe("fetchWithSsrfGuard: lookupFn without pinnedFetchImpl", () => {
	const lookupFn: LookupFn = async () => [
		{ address: "93.184.216.34", family: 4 },
	];

	it("throws when a lookupFn is provided without a pinnedFetchImpl", async () => {
		const fetchImpl = vi.fn(async () => new Response("ok", { status: 200 }));
		await expect(
			fetchWithSsrfGuard({
				url: "https://example.com/resource",
				fetchImpl,
				lookupFn,
			}),
		).rejects.toThrow(/lookupFn was provided without a pinnedFetchImpl/i);
		// It must NOT have connected through the unpinned fetcher.
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("succeeds when a lookupFn is paired with a pinnedFetchImpl", async () => {
		const pinnedFetchImpl: PinnedLookupFetchLike = vi.fn(
			async () => new Response("pinned", { status: 200 }),
		);
		const { response, release } = await fetchWithSsrfGuard({
			url: "https://example.com/resource",
			// fetchImpl suppresses the node defaults so this test asserts the
			// explicit pinned path only.
			fetchImpl: vi.fn(async () => new Response("unpinned", { status: 200 })),
			lookupFn,
			pinnedFetchImpl,
		});
		expect(response.status).toBe(200);
		expect(await response.text()).toBe("pinned");
		expect(pinnedFetchImpl).toHaveBeenCalledTimes(1);
		await release();
	});

	it("still allows the plain fetchImpl path with no lookupFn (unaffected)", async () => {
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
