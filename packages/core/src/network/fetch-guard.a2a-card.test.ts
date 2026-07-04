import { describe, expect, it, vi } from "vitest";
import { fetchWithSsrfGuard } from "./fetch-guard.ts";
import { nodePinnedFetch } from "./node-pinned-fetch.ts";
import { SsrfBlockedError } from "./ssrf.ts";

/**
 * Regression guard for #12229 L9: the Feed A2A agent-card fetch routes through
 * fetchWithSsrfGuard, so an operator/agent-supplied card URL cannot reach a
 * private/link-local target. Deterministic — a stub lookupFn stands in for DNS,
 * so no real resolution/egress happens; asserts the guard refuses (throws) and
 * never calls the pinned transport for a private-resolving host.
 */
describe("fetchWithSsrfGuard for the A2A agent-card URL (#12229 L9)", () => {
	it.each([
		"http://169.254.169.254/.well-known/agent-card.json",
		"http://10.0.0.5/.well-known/agent-card.json",
		"http://127.0.0.1:3000/.well-known/agent-card.json",
		"http://[::1]/.well-known/agent-card.json",
	])("blocks a card URL at the literal internal target %s", async (url) => {
		const pinnedFetchImpl = vi.fn(nodePinnedFetch);
		await expect(
			fetchWithSsrfGuard({ url, pinnedFetchImpl }),
		).rejects.toBeInstanceOf(SsrfBlockedError);
		expect(pinnedFetchImpl).not.toHaveBeenCalled();
	});

	it("blocks a public card hostname that resolves to the metadata IP (rebinding)", async () => {
		// Attacker controls DNS for a public-looking card host and points it at the
		// cloud metadata address. A raw fetch would connect; the guard resolves +
		// screens the address and refuses before any socket is opened.
		const lookupFn = vi.fn(async () => [
			{ address: "169.254.169.254", family: 4 },
		]);
		const pinnedFetchImpl = vi.fn(nodePinnedFetch);
		await expect(
			fetchWithSsrfGuard({
				url: "https://cards.attacker.example/.well-known/agent-card.json",
				lookupFn,
				pinnedFetchImpl,
			}),
		).rejects.toBeInstanceOf(SsrfBlockedError);
		expect(lookupFn).toHaveBeenCalledTimes(1);
		expect(pinnedFetchImpl).not.toHaveBeenCalled();
	});

	it("allows a public card host that resolves to a public IP", async () => {
		const lookupFn = vi.fn(async () => [
			{ address: "93.184.216.34", family: 4 },
		]);
		const pinnedFetchImpl = vi.fn(
			async () => new Response('{"name":"feed"}', { status: 200 }),
		);
		const { response, release } = await fetchWithSsrfGuard({
			url: "https://cards.example.com/.well-known/agent-card.json",
			lookupFn,
			pinnedFetchImpl,
		});
		expect(response.status).toBe(200);
		expect(pinnedFetchImpl).toHaveBeenCalledTimes(1);
		await release();
	});
});
