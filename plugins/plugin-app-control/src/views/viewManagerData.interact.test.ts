/**
 * TUI interact capability tests for listing and opening terminal views.
 *
 * These cover happy paths plus missing, unknown, and unsupported capability inputs.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { interact } from "./viewManagerData";

const tuiViews = {
	views: [
		{
			id: "wallet",
			label: "Wallet",
			viewType: "tui",
			path: "/wallet/tui",
			available: true,
			pluginName: "@elizaos/plugin-wallet-ui",
		},
		{
			id: "messages",
			label: "Messages",
			viewType: "tui",
			path: "/messages/tui",
			available: true,
			pluginName: "@elizaos/plugin-messages",
		},
	],
};

function jsonResponse(body: unknown) {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	});
}

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("interact() happy paths", () => {
	it("terminal-list-views returns the tui-scoped view list", async () => {
		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			expect(String(input)).toBe("/api/views?viewType=tui");
			return jsonResponse(tuiViews);
		});
		vi.stubGlobal("fetch", fetchMock);

		await expect(interact("terminal-list-views")).resolves.toEqual(tuiViews);
		expect(fetchMock).toHaveBeenCalledOnce();
	});

	it("terminal-open-view navigates the matched view and reports its viewType", async () => {
		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url === "/api/views?viewType=tui") return jsonResponse(tuiViews);
			if (url === "/api/views/messages/navigate?viewType=tui")
				return jsonResponse({ ok: true });
			throw new Error(`Unexpected request: ${url}`);
		});
		vi.stubGlobal("fetch", fetchMock);

		await expect(
			interact("terminal-open-view", { viewId: "messages" }),
		).resolves.toEqual({
			opened: true,
			viewId: "messages",
			viewType: "tui",
		});
		expect(fetchMock).toHaveBeenCalledWith(
			"/api/views/messages/navigate?viewType=tui",
			expect.objectContaining({
				method: "POST",
				body: JSON.stringify({ path: "/messages/tui", viewType: "tui" }),
			}),
		);
	});
});

describe("interact() error paths", () => {
	it("terminal-open-view rejects with 'viewId is required' when viewId is missing", async () => {
		// No fetch should be needed before the guard fires; stub defensively.
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => jsonResponse(tuiViews)),
		);
		await expect(interact("terminal-open-view")).rejects.toThrow(
			"viewId is required",
		);
		await expect(
			interact("terminal-open-view", { viewId: "" }),
		).rejects.toThrow("viewId is required");
		await expect(
			interact("terminal-open-view", { viewId: 42 as unknown as string }),
		).rejects.toThrow("viewId is required");
	});

	it("terminal-open-view rejects with 'View \"x\" not found' for an unknown viewId", async () => {
		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			if (String(input) === "/api/views?viewType=tui")
				return jsonResponse(tuiViews);
			throw new Error(`Unexpected request: ${String(input)}`);
		});
		vi.stubGlobal("fetch", fetchMock);

		await expect(
			interact("terminal-open-view", { viewId: "ghost" }),
		).rejects.toThrow('View "ghost" not found');
		// It fetched the tui list to attempt the lookup, but never navigated.
		expect(fetchMock).toHaveBeenCalledWith("/api/views?viewType=tui");
		expect(
			fetchMock.mock.calls.some((c) => String(c[0]).includes("/navigate")),
		).toBe(false);
	});

	it("rejects with 'Unsupported capability' for an unknown capability", async () => {
		await expect(interact("totally-unknown")).rejects.toThrow(
			/Unsupported capability/,
		);
		await expect(interact("totally-unknown")).rejects.toThrow(
			'Unsupported capability "totally-unknown"',
		);
	});
});
