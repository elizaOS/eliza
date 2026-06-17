// Contract test: runs the plugin's REAL parser (fetchViewEntries) over a
// response shaped exactly like the live GET /api/views payload.
//
// The canonical entry shape is ViewRegistryEntry in
// packages/ui/src/hooks/useAvailableViews.ts (the type the /api/views endpoint
// serves). The fixture below mirrors every field of that interface so the
// parser is exercised against the real DTO contract, not a trimmed stub. If the
// /api/views contract changes, update useAvailableViews.ts AND this fixture
// together. fetchViewEntries must tolerate the full shape and surface the
// fields the ViewManager UI reads (id/label/viewType/path/available/pluginName/
// heroImageUrl).

import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchViewEntries } from "./viewManagerData";

/**
 * One realistic /api/views entry covering the complete ViewRegistryEntry shape
 * from packages/ui/src/hooks/useAvailableViews.ts. Keep these fields in sync
 * with that interface.
 */
const fullEntry = {
	id: "wallet.inventory",
	label: "Wallet",
	viewType: "gui",
	description: "Inspect balances and recent transactions",
	icon: "Wallet",
	path: "/apps/wallet",
	bundleUrl: "/api/views/wallet.inventory/bundle.js",
	componentExport: "WalletInventoryView",
	heroImageUrl: "/api/views/wallet.inventory/hero",
	hasHeroImage: true,
	available: true,
	pluginName: "@elizaos/plugin-wallet-ui",
	tags: ["finance", "wallet"],
	developerOnly: false,
	visibleInManager: true,
	capabilities: [{ id: "open-wallet", description: "Open the wallet view" }],
	builtin: false,
	desktopTabEnabled: true,
};

const tuiEntry = {
	id: "messages.terminal",
	label: "Messages",
	viewType: "tui",
	path: "/messages/tui",
	available: false,
	pluginName: "@elizaos/plugin-messages",
};

function jsonResponse(body: unknown, init?: ResponseInit) {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { "Content-Type": "application/json" },
		...init,
	});
}

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("fetchViewEntries contract (/api/views ViewRegistryEntry shape)", () => {
	it("parses a real-shaped payload and preserves the UI-consumed fields", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: RequestInfo | URL) => {
				expect(String(input)).toBe("/api/views");
				return jsonResponse({ views: [fullEntry, tuiEntry] });
			}),
		);

		const entries = await fetchViewEntries();
		expect(entries).toHaveLength(2);

		const [wallet, messages] = entries;
		// Fields the ViewManager UI actually renders survive the parse intact.
		expect(wallet.id).toBe("wallet.inventory");
		expect(wallet.label).toBe("Wallet");
		expect(wallet.viewType).toBe("gui");
		expect(wallet.path).toBe("/apps/wallet");
		expect(wallet.available).toBe(true);
		expect(wallet.pluginName).toBe("@elizaos/plugin-wallet-ui");
		expect(wallet.heroImageUrl).toBe("/api/views/wallet.inventory/hero");
		expect(wallet.description).toBe("Inspect balances and recent transactions");

		expect(messages.id).toBe("messages.terminal");
		expect(messages.viewType).toBe("tui");
		expect(messages.available).toBe(false);
		expect(messages.pluginName).toBe("@elizaos/plugin-messages");
	});

	it("forwards ?viewType=tui to the endpoint when scoped", async () => {
		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			expect(String(input)).toBe("/api/views?viewType=tui");
			return jsonResponse({ views: [tuiEntry] });
		});
		vi.stubGlobal("fetch", fetchMock);

		const entries = await fetchViewEntries("tui");
		expect(entries).toHaveLength(1);
		expect(entries[0].id).toBe("messages.terminal");
		expect(fetchMock).toHaveBeenCalledOnce();
	});

	it("returns [] when the payload's views field is not an array", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => jsonResponse({ views: null })),
		);
		await expect(fetchViewEntries()).resolves.toEqual([]);

		vi.stubGlobal(
			"fetch",
			vi.fn(async () => jsonResponse({})),
		);
		await expect(fetchViewEntries()).resolves.toEqual([]);
	});

	it("throws 'HTTP <status>' on a non-ok response", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => jsonResponse({ error: "nope" }, { status: 404 })),
		);
		await expect(fetchViewEntries()).rejects.toThrow("HTTP 404");

		vi.stubGlobal(
			"fetch",
			vi.fn(async () => jsonResponse({ error: "boom" }, { status: 500 })),
		);
		await expect(fetchViewEntries("tui")).rejects.toThrow("HTTP 500");
	});
});
