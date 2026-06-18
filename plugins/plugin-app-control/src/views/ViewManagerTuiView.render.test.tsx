// @vitest-environment jsdom
//
// Render tests for the TUI ViewManagerTuiView React component.
// Asserts the populated terminal row data (zero-padded index, label, viewType
// cell, id, ready/missing status badge), the data-view-state / data-status JSON
// attributes (viewCount, lastAction transitions), and every control behavior:
// the per-row 'open' button (success + failure) and the 'refresh' button.

import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ViewManagerTuiView } from "./ViewManagerView";

interface FetchCall {
	url: string;
	init?: RequestInit;
}

function jsonResponse(body: unknown, init?: ResponseInit) {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { "Content-Type": "application/json" },
		...init,
	});
}

/** Two TUI entries — one available, one not — with distinct labels/paths/ids. */
const tuiViews = {
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
			available: false,
			pluginName: "@elizaos/plugin-messages",
		},
	],
};

function stubFetch(
	handler: (call: FetchCall) => Response | Promise<Response>,
): {
	calls: FetchCall[];
} {
	const calls: FetchCall[] = [];
	const mock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
		const call = { url: String(input), init };
		calls.push(call);
		return handler(call);
	});
	vi.stubGlobal("fetch", mock);
	return { calls };
}

function viewState(): {
	viewType: string;
	viewCount: number;
	lastAction: string;
} {
	const node = document.querySelector("[data-view-state]");
	if (!node) throw new Error("no data-view-state node");
	return JSON.parse(node.getAttribute("data-view-state") ?? "{}");
}

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("ViewManagerTuiView render", () => {
	it("renders populated rows, status badges, and the data-view-state JSON attr", async () => {
		const { calls } = stubFetch(({ url }) => {
			if (url === "/api/views?viewType=tui") return jsonResponse(tuiViews);
			throw new Error(`Unexpected request: ${url}`);
		});

		render(<ViewManagerTuiView />);

		// Title line.
		await screen.findByText("elizaos://views-manager --type=tui");

		// Wait for rows to populate.
		await screen.findByText("Wallet");
		expect(screen.getByText("Messages")).toBeTruthy();

		// Zero-padded indices.
		expect(screen.getByText("01")).toBeTruthy();
		expect(screen.getByText("02")).toBeTruthy();

		// viewType cell (two rows, both "tui").
		expect(screen.getAllByText("tui").length).toBeGreaterThanOrEqual(2);

		// id cells.
		expect(screen.getByText("wallet")).toBeTruthy();
		expect(screen.getByText("messages")).toBeTruthy();

		// Status badges: available -> ready, unavailable -> missing.
		expect(screen.getByText("ready")).toBeTruthy();
		expect(screen.getByText("missing")).toBeTruthy();

		// description?|pluginName subrow: wallet has a description; messages
		// falls back to its pluginName.
		expect(screen.getByText("Terminal wallet controls")).toBeTruthy();
		expect(screen.getByText("@elizaos/plugin-messages")).toBeTruthy();

		// data-view-state reflects viewType=tui, viewCount=2, lastAction after load.
		const state = viewState();
		expect(state.viewType).toBe("tui");
		expect(state.viewCount).toBe(2);
		expect(state.lastAction).toBe("refreshed");

		// The TUI list fetch is scoped with ?viewType=tui.
		expect(calls[0].url).toBe("/api/views?viewType=tui");
	});

	it("renders 'no tui views registered' for an empty payload", async () => {
		stubFetch(({ url }) => {
			if (url === "/api/views?viewType=tui") return jsonResponse({ views: [] });
			throw new Error(`Unexpected request: ${url}`);
		});

		render(<ViewManagerTuiView />);
		await screen.findByText("no tui views registered");
		expect(viewState().viewCount).toBe(0);
	});

	it("renders the danger error line when the fetch resolves non-ok", async () => {
		stubFetch(({ url }) => {
			if (url === "/api/views?viewType=tui")
				return jsonResponse({ error: "boom" }, { status: 503 });
			throw new Error(`Unexpected request: ${url}`);
		});

		render(<ViewManagerTuiView />);
		await screen.findByText("HTTP 503");
		expect(screen.queryByText("no tui views registered")).toBeNull();
	});

	it("row 'open' button POSTs navigate?viewType=tui and flips lastAction to 'opened <id>'", async () => {
		const { calls } = stubFetch(({ url }) => {
			if (url === "/api/views?viewType=tui") return jsonResponse(tuiViews);
			if (url === "/api/views/wallet/navigate?viewType=tui")
				return jsonResponse({ ok: true });
			throw new Error(`Unexpected request: ${url}`);
		});

		render(<ViewManagerTuiView />);
		const openBtn = await screen.findByLabelText("Open Wallet");
		fireEvent.click(openBtn);

		await waitFor(() => {
			expect(viewState().lastAction).toBe("opened wallet");
		});

		const navCall = calls.find((c) => c.url.includes("/navigate"));
		expect(navCall?.url).toBe("/api/views/wallet/navigate?viewType=tui");
		expect(navCall?.init?.method).toBe("POST");
		expect(navCall?.init?.body).toBe(
			JSON.stringify({ path: "/wallet/tui", viewType: "tui" }),
		);

		// data-status mirrors lastAction.
		const statusNode = document.querySelector("[data-status]");
		expect(statusNode?.getAttribute("data-status")).toBe("opened wallet");
	});

	it("row 'open' failure flips lastAction to 'open failed: <msg>'", async () => {
		stubFetch(({ url }) => {
			if (url === "/api/views?viewType=tui") return jsonResponse(tuiViews);
			if (url === "/api/views/wallet/navigate?viewType=tui")
				return Promise.reject(new Error("network down"));
			throw new Error(`Unexpected request: ${url}`);
		});

		render(<ViewManagerTuiView />);
		const openBtn = await screen.findByLabelText("Open Wallet");
		fireEvent.click(openBtn);

		await waitFor(() => {
			expect(viewState().lastAction).toBe("open failed: network down");
		});
	});

	it("'refresh' button refetches with ?viewType=tui and sets lastAction='refreshed'", async () => {
		const { calls } = stubFetch(({ url }) => {
			if (url === "/api/views?viewType=tui") return jsonResponse(tuiViews);
			throw new Error(`Unexpected request: ${url}`);
		});

		render(<ViewManagerTuiView />);
		await screen.findByText("Wallet");
		expect(
			calls.filter((c) => c.url === "/api/views?viewType=tui"),
		).toHaveLength(1);

		fireEvent.click(screen.getByLabelText("Refresh TUI views"));

		await waitFor(() => {
			expect(
				calls.filter((c) => c.url === "/api/views?viewType=tui"),
			).toHaveLength(2);
		});
		expect(viewState().lastAction).toBe("refreshed");
	});
});
