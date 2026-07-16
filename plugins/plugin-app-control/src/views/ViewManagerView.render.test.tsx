/**
 * Exercises ViewManagerView's fetch, state, and navigation boundaries with browser-style responses.
 * @vitest-environment jsdom
 */

import {
	emitViewEvent,
	NAVIGATE_VIEW_EVENT,
	VIEW_EVENTS,
} from "@elizaos/ui/events";
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

describe("ViewManagerView GUI wrapper", () => {
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

	it("uses the CSRF-aware POST then dispatches local navigation without a server echo", async () => {
		vi.spyOn(document, "cookie", "get").mockReturnValue(
			"eliza_csrf=view-manager-token",
		);
		const { calls } = stubFetch(({ url }) => {
			if (url === "/api/views") return jsonResponse(guiViews);
			if (url === "/api/views/wallet/navigate")
				return jsonResponse({ ok: true });
			throw new Error(`Unexpected request: ${url}`);
		});

		const navigateEvents: CustomEvent[] = [];
		const onNavigate = (event: Event) =>
			navigateEvents.push(event as CustomEvent);
		window.addEventListener(NAVIGATE_VIEW_EVENT, onNavigate);
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
		// Crucial default-modality distinction: no ?viewType query string.
		expect(navCall?.url).toBe("/api/views/wallet/navigate");
		expect(navCall?.url).not.toContain("?viewType");
		expect(navCall?.init?.method).toBe("POST");
		expect(navCall?.init?.credentials).toBe("include");
		expect(new Headers(navCall?.init?.headers).get("x-eliza-csrf")).toBe(
			"view-manager-token",
		);
		expect(navCall?.init?.body).toBe(
			JSON.stringify({
				path: "/wallet",
				viewType: undefined,
				source: "user",
			}),
		);
		expect(navigateEvents).toHaveLength(1);
		expect(navigateEvents[0]?.detail).toMatchObject({
			viewId: "wallet",
			viewPath: "/wallet",
			viewLabel: "Wallet",
			viewType: "gui",
		});
		window.removeEventListener(NAVIGATE_VIEW_EVENT, onNavigate);
	});

	it("surfaces a failed open and does not dispatch local navigation", async () => {
		const { calls } = stubFetch(({ url }) => {
			if (url === "/api/views") return jsonResponse(guiViews);
			if (url === "/api/views/wallet/navigate") {
				return jsonResponse({ error: "offline" }, { status: 503 });
			}
			throw new Error(`Unexpected request: ${url}`);
		});
		const navigateEvents: CustomEvent[] = [];
		const onNavigate = (event: Event) =>
			navigateEvents.push(event as CustomEvent);
		window.addEventListener(NAVIGATE_VIEW_EVENT, onNavigate);

		const { container } = render(<ViewManagerView />);
		await screen.findByText("Wallet");
		fireEvent.click(
			container.querySelector<HTMLButtonElement>(
				'[data-agent-id="open:wallet"]',
			) as HTMLButtonElement,
		);

		await screen.findByText("Could not open view: HTTP 503");
		expect(calls.some((call) => call.url.endsWith("/navigate"))).toBe(true);
		expect(navigateEvents).toHaveLength(0);
		window.removeEventListener(NAVIGATE_VIEW_EVENT, onNavigate);
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
		await screen.findByText(/HTTP 500/);
	});

	it("renders malformed registry data as an error rather than a healthy empty state", async () => {
		stubFetch(({ url }) => {
			if (url === "/api/views") return jsonResponse({ status: "ready" });
			throw new Error(`Unexpected request: ${url}`);
		});

		render(<ViewManagerView />);
		await screen.findByText(
			"GET /api/views response must contain a views array",
		);
		expect(screen.queryByText("None")).toBeNull();
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

	it("collapses duplicate future-modality declarations of one id into a single row with modality chips", async () => {
		// /api/views can return the same logical view once per surface. The list
		// must show it once, with one chip per surface, so a future modality does
		// not duplicate the base GUI row.
		const dupViews = {
			views: [
				{
					id: "future-surface",
					label: "Future Surface",
					viewType: "gui",
					path: "/future-surface",
					available: true,
					pluginName: "@elizaos/plugin-future-surface",
				},
				{
					id: "future-surface",
					label: "Future Surface Spatial",
					viewType: "xr",
					path: "/future-surface",
					available: true,
					pluginName: "@elizaos/plugin-future-surface",
				},
				{
					id: "future-surface",
					label: "Future Surface Terminal",
					viewType: "tui",
					path: "/future-surface",
					available: true,
					pluginName: "@elizaos/plugin-future-surface",
				},
			],
		};
		stubFetch(({ url }) => {
			if (url === "/api/views") return jsonResponse(dupViews);
			throw new Error(`Unexpected request: ${url}`);
		});

		const { container } = render(<ViewManagerView />);
		await screen.findByText("Future Surface");

		// Exactly one open control for the collapsed id, labelled from the gui base.
		const openButtons = container.querySelectorAll('[data-agent-id^="open:"]');
		expect(openButtons).toHaveLength(1);
		expect(
			container.querySelector('[data-agent-id="open:future-surface"]'),
		).toBeTruthy();
		expect(screen.queryByText("Future Surface Spatial")).toBeNull();
		expect(screen.queryByText("Future Surface Terminal")).toBeNull();

		// One modality chip per surface, ordered gui · xr · tui.
		expect(screen.getByText("gui")).toBeTruthy();
		expect(screen.getByText("xr")).toBeTruthy();
		expect(screen.getByText("tui")).toBeTruthy();
	});

	it("uses the same export and fetches the gui list (no viewType qs)", async () => {
		// The manifest uses componentExport "ViewManagerView" — the exact export
		// rendered here — and fetchViewEntries() is called with no viewType, so the
		// default mount hits GET /api/views with no query string.
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
