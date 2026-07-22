/**
 * Exercises View Manager parsing against realistic live registry payloads and modality merges.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
	collapseViewEntries,
	fetchViewEntries,
	type ViewEntry,
} from "./viewManagerData";

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

const futureEntry = {
	id: "future.console",
	label: "Future Console",
	viewType: "tui",
	path: "/future-console",
	available: false,
	pluginName: "@elizaos/plugin-future-surface",
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
				return jsonResponse({ views: [fullEntry, futureEntry] });
			}),
		);

		const entries = await fetchViewEntries();
		expect(entries).toHaveLength(2);

		const [wallet, future] = entries;
		// Fields the ViewManager UI actually renders survive the parse intact.
		expect(wallet.id).toBe("wallet.inventory");
		expect(wallet.label).toBe("Wallet");
		expect(wallet.viewType).toBe("gui");
		expect(wallet.path).toBe("/apps/wallet");
		expect(wallet.available).toBe(true);
		expect(wallet.pluginName).toBe("@elizaos/plugin-wallet-ui");
		expect(wallet.heroImageUrl).toBe("/api/views/wallet.inventory/hero");
		expect(wallet.description).toBe("Inspect balances and recent transactions");

		expect(future.id).toBe("future.console");
		expect(future.viewType).toBe("tui");
		expect(future.available).toBe(false);
		expect(future.pluginName).toBe("@elizaos/plugin-future-surface");
	});

	it("forwards a non-GUI viewType to the endpoint when scoped", async () => {
		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			expect(String(input)).toBe("/api/views?viewType=tui");
			return jsonResponse({ views: [futureEntry] });
		});
		vi.stubGlobal("fetch", fetchMock);

		const entries = await fetchViewEntries("tui");
		expect(entries).toHaveLength(1);
		expect(entries[0].id).toBe("future.console");
		expect(fetchMock).toHaveBeenCalledOnce();
	});

	it("rejects when the payload's views field is not an array", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => jsonResponse({ views: null })),
		);
		await expect(fetchViewEntries()).rejects.toMatchObject({
			name: "ElizaError",
			code: "VIEW_MANAGER_LIST_RESPONSE_INVALID",
		});

		vi.stubGlobal(
			"fetch",
			vi.fn(async () => jsonResponse({})),
		);
		await expect(fetchViewEntries()).rejects.toMatchObject({
			name: "ElizaError",
			code: "VIEW_MANAGER_LIST_RESPONSE_INVALID",
		});
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

function entry(id: string, patch: Partial<ViewEntry> = {}): ViewEntry {
	return {
		id,
		label: id,
		available: true,
		pluginName: `@elizaos/plugin-${id}`,
		...patch,
	};
}

describe("collapseViewEntries", () => {
	it("collapses same-id future-modality declarations into one entry with the surface union", () => {
		const collapsed = collapseViewEntries([
			entry("future-surface", { label: "Future Surface", viewType: "gui" }),
			entry("future-surface", {
				label: "Future Surface Spatial",
				viewType: "xr",
			}),
			entry("future-surface", {
				label: "Future Surface Terminal",
				viewType: "tui",
			}),
		]);
		expect(collapsed).toHaveLength(1);
		expect(collapsed[0].id).toBe("future-surface");
		// gui base wins the label (clean, no surface suffix).
		expect(collapsed[0].label).toBe("Future Surface");
		// Surfaces unioned and ordered gui · xr · tui.
		expect(collapsed[0].modalities).toEqual(["gui", "xr", "tui"]);
	});

	it("prefers the gui declaration as the base even when it arrives after a non-gui one", () => {
		const collapsed = collapseViewEntries([
			entry("future-surface", {
				label: "Future Surface Terminal",
				viewType: "tui",
			}),
			entry("future-surface", { label: "Future Surface", viewType: "gui" }),
		]);
		expect(collapsed).toHaveLength(1);
		expect(collapsed[0].label).toBe("Future Surface");
		expect(collapsed[0].modalities).toEqual(["gui", "tui"]);
	});

	it("preserves first-seen order and leaves distinct ids untouched (one modality each)", () => {
		const collapsed = collapseViewEntries([
			entry("wallet", { viewType: "gui" }),
			entry("future-surface", { viewType: "tui" }),
			entry("wallet", { viewType: "tui" }),
		]);
		expect(collapsed.map((e) => e.id)).toEqual(["wallet", "future-surface"]);
		expect(collapsed[0].modalities).toEqual(["gui", "tui"]);
		expect(collapsed[1].modalities).toEqual(["tui"]);
	});

	it("honors a pre-set modalities array (one declaration drawing several surfaces)", () => {
		// Non-shipping fixture (#15269): no plugin ships tui/xr views, but the
		// collapse contract must keep honoring multi-modal declarations so
		// reintroduction stays a manifest edit, not a schema change.
		const collapsed = collapseViewEntries([
			entry("future-surface", { modalities: ["gui", "xr", "tui"] }),
		]);
		expect(collapsed).toHaveLength(1);
		expect(collapsed[0].modalities).toEqual(["gui", "xr", "tui"]);
	});
});
