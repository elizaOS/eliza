import { afterEach, describe, expect, it, vi } from "vitest";
import { interact } from "./viewManagerData";

const viewsResponse = {
	views: [
		{
			id: "wallet",
			label: "Wallet",
			viewType: "tui",
			description: "Terminal wallet controls",
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

function jsonResponse(body: unknown, init?: ResponseInit) {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { "Content-Type": "application/json" },
		...init,
	});
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("ViewManagerTuiView", () => {
	it("lists and opens TUI views through terminal capabilities", async () => {
		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url === "/api/views?viewType=tui") {
				return jsonResponse(viewsResponse);
			}
			if (url === "/api/views/messages/navigate?viewType=tui") {
				return jsonResponse({ ok: true });
			}
			throw new Error(`Unexpected request: ${url}`);
		});
		vi.stubGlobal("fetch", fetchMock);

		await expect(interact("terminal-list-views")).resolves.toEqual(
			viewsResponse,
		);
		await expect(
			interact("terminal-open-view", { viewId: "messages" }),
		).resolves.toEqual({ opened: true, viewId: "messages", viewType: "tui" });

		expect(fetchMock).toHaveBeenCalledWith(
			"/api/views/messages/navigate?viewType=tui",
			expect.objectContaining({
				method: "POST",
				body: JSON.stringify({ path: "/messages/tui", viewType: "tui" }),
			}),
		);
	});
});
