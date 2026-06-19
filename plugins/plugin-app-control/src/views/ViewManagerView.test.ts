import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { interact } from "./viewManagerData";

const source = readFileSync(
	resolve(dirname(fileURLToPath(import.meta.url)), "ViewManagerView.tsx"),
	"utf8",
);

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
	it("inherits shell theme tokens instead of hardcoded cyan shell chrome", () => {
		expect(source).toContain("viewManagerTheme");
		expect(source).toContain("var(--background");
		expect(source).toContain("var(--accent");
		expect(source).not.toContain('background: "#0f0f1a"');
		expect(source).not.toContain('background: "#020617"');
		expect(source).not.toContain("#7dd3fc");
		expect(source).not.toContain("#6c63ff");
		expect(source).not.toContain("rgba(");
	});

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
