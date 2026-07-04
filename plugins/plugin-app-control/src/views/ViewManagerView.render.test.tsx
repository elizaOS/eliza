/**
 * Behavior tests for the consolidated ViewManagerView wrapper.
 *
 * The wrapper owns GET /api/views fetching and open-to-navigate handoff while
 * rendering the shared ViewManagerSpatialView inside a SpatialSurface.
 *
 * @vitest-environment jsdom
 */

import { emitViewEvent, VIEW_EVENTS } from "@elizaos/ui/events";
import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ViewManagerView } from "./ViewManagerView";

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

/** A two-entry payload: one available view and one unavailable view. */
const guiViews = {
	views: [
		{
			id: "wallet",
			label: "Wallet",
			path: "/wallet",
			available: true,
			pluginName: "@elizaos/plugin-wallet-ui",
			heroImageUrl: "/api/views/wallet/hero",
		},
		{
			id: "feed",
			label: "Feed",
			path: "/feed",
			available: false,
			pluginName: "@elizaos/plugin-feed",
		},
	],
};

function stubFetch(handler: (call: FetchCall) => Response): {
	calls: FetchCall[];
	mock: ReturnType<typeof vi.fn>;
} {
	const calls: FetchCall[] = [];
	const mock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
		const call = { url: String(input), init };
		calls.push(call);
		return handler(call);
	});
	vi.stubGlobal("fetch", mock);
	return { calls, mock };
}

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("ViewManagerView (gui/xr) wrapper", () => {
	it("fetches GET /api/views (no viewType qs) and renders the populated list", async () => {
		const { calls } = stubFetch(({ url }) => {
			if (url === "/api/views") return jsonResponse(guiViews);
			throw new Error(`Unexpected request: ${url}`);
		});

		render(<ViewManagerView />);

		// Both labels render once the snapshot lands.
		await screen.findByText("Wallet");
		expect(screen.getByText("Feed")).toBeTruthy();

		// Paths render as the muted subtitle for each row.
		expect(screen.getByText("/wallet")).toBeTruthy();
		expect(screen.getByText("/feed")).toBeTruthy();

		// Per-view open/available state: available -> "ready", unavailable -> "missing".
		expect(screen.getByText("ready")).toBeTruthy();
		expect(screen.getByText("missing")).toBeTruthy();

		// The list fetch hits GET /api/views with NO query string (gui distinction).
		expect(calls[0].url).toBe("/api/views");
		expect(calls[0].init?.method ?? "GET").toBe("GET");
		expect(calls[0].url).not.toContain("?viewType");
	});

	it("opens a view via POST navigate with NO ?viewType query string (gui distinction)", async () => {
		const { calls } = stubFetch(({ url }) => {
			if (url === "/api/views") return jsonResponse(guiViews);
			if (url === "/api/views/wallet/navigate")
				return jsonResponse({ ok: true });
			throw new Error(`Unexpected request: ${url}`);
		});

		const { container } = render(<ViewManagerView />);
		await screen.findByText("Wallet");

		// Each row carries an `open:<id>` Button that drives navigation.
		const openWallet = container.querySelector<HTMLButtonElement>(
			'[data-agent-id="open:wallet"]',
		);
		expect(openWallet).toBeTruthy();
		fireEvent.click(openWallet as HTMLButtonElement);

		await waitFor(() => {
			expect(calls.find((c) => c.url.includes("/navigate"))).toBeTruthy();
		});

		const navCall = calls.find((c) => c.url.includes("/navigate"));
		// Crucial gui-vs-tui distinction: no ?viewType query string.
		expect(navCall?.url).toBe("/api/views/wallet/navigate");
		expect(navCall?.url).not.toContain("?viewType");
		expect(navCall?.init?.method).toBe("POST");
		expect(navCall?.init?.body).toBe(
			JSON.stringify({ path: "/wallet", viewType: undefined }),
		);
	});

	it("renders the empty state for an empty payload", async () => {
		stubFetch(({ url }) => {
			if (url === "/api/views") return jsonResponse({ views: [] });
			throw new Error(`Unexpected request: ${url}`);
		});

		render(<ViewManagerView />);
		await screen.findByText("None");
		// No open controls should be present.
		expect(document.querySelector('[data-agent-id^="open:"]')).toBeNull();
	});

	it("surfaces the error branch when the fetch resolves non-ok (HTTP 500)", async () => {
		stubFetch(({ url }) => {
			if (url === "/api/views")
				return jsonResponse({ error: "boom" }, { status: 500 });
			throw new Error(`Unexpected request: ${url}`);
		});

		render(<ViewManagerView />);
		await screen.findByText("HTTP 500");
	});

	it("shows 'loading' before the fetch resolves", async () => {
		let resolveFetch: ((r: Response) => void) | undefined;
		const pending = new Promise<Response>((r) => {
			resolveFetch = r;
		});
		const mock = vi.fn(async () => pending);
		vi.stubGlobal("fetch", mock);

		render(<ViewManagerView />);
		// The header reports loading synchronously before the promise resolves.
		expect(screen.getByText("loading")).toBeTruthy();

		resolveFetch?.(jsonResponse(guiViews));
		await screen.findByText("Wallet");
	});

	it("refreshes the list when a plugin_reloaded event is broadcast (#8916)", async () => {
		let response = guiViews;
		const { calls } = stubFetch(({ url }) => {
			if (url === "/api/views") return jsonResponse(response);
			throw new Error(`Unexpected request: ${url}`);
		});

		render(<ViewManagerView />);
		await screen.findByText("Wallet");
		expect(calls.filter((c) => c.url === "/api/views")).toHaveLength(1);

		response = {
			views: [
				...guiViews.views,
				{
					id: "habit-tracker",
					label: "Habit Tracker",
					path: "/habit-tracker",
					available: true,
					pluginName: "@elizaos/plugin-habit-tracker",
				},
			],
		};
		act(() => {
			emitViewEvent(
				VIEW_EVENTS.PLUGIN_RELOADED,
				{ pluginName: "@elizaos/plugin-habit-tracker" },
				"agent",
			);
		});

		await screen.findByText("Habit Tracker");
		expect(calls.filter((c) => c.url === "/api/views")).toHaveLength(2);
	});

	it("collapses duplicate gui/xr/tui declarations of one id into a single row with modality chips", async () => {
		// /api/views can return the same logical view once per surface. The list
		// must show it ONCE, with one chip per surface (no "Phone / Phone XR /
		// Phone TUI" duplicates).
		const dupViews = {
			views: [
				{
					id: "phone",
					label: "Phone",
					viewType: "gui",
					path: "/phone",
					available: true,
					pluginName: "@elizaos/plugin-phone",
				},
				{
					id: "phone",
					label: "Phone XR",
					viewType: "xr",
					path: "/phone",
					available: true,
					pluginName: "@elizaos/plugin-phone",
				},
				{
					id: "phone",
					label: "Phone TUI",
					viewType: "tui",
					path: "/phone",
					available: true,
					pluginName: "@elizaos/plugin-phone",
				},
			],
		};
		stubFetch(({ url }) => {
			if (url === "/api/views") return jsonResponse(dupViews);
			throw new Error(`Unexpected request: ${url}`);
		});

		const { container } = render(<ViewManagerView />);
		await screen.findByText("Phone");

		// Exactly one open control for the collapsed id, labelled from the gui base.
		const openButtons = container.querySelectorAll('[data-agent-id^="open:"]');
		expect(openButtons).toHaveLength(1);
		expect(
			container.querySelector('[data-agent-id="open:phone"]'),
		).toBeTruthy();
		expect(screen.queryByText("Phone XR")).toBeNull();
		expect(screen.queryByText("Phone TUI")).toBeNull();

		// One modality chip per surface, ordered gui · xr · tui.
		expect(screen.getByText("gui")).toBeTruthy();
		expect(screen.getByText("xr")).toBeTruthy();
		expect(screen.getByText("tui")).toBeTruthy();
	});

	it("XR reuses the same export and fetches the gui list (no viewType qs)", async () => {
		// The xr entry in src/index.ts uses componentExport "ViewManagerView" — the
		// exact export rendered here — and fetchViewEntries() is called with no
		// viewType, so the xr mount hits GET /api/views with no query string.
		const { calls } = stubFetch(({ url }) => {
			if (url === "/api/views") return jsonResponse(guiViews);
			throw new Error(`Unexpected request: ${url}`);
		});

		render(<ViewManagerView />);
		await screen.findByText("Wallet");

		expect(calls).toHaveLength(1);
		expect(calls[0].url).toBe("/api/views");
		expect(calls[0].url).not.toContain("?viewType");
	});
});
/**
 * View manager render tests for populated, empty, and interaction states.
 */
