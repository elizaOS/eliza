// @vitest-environment jsdom
//
// Render tests for the GUI (and XR-reused) ViewManagerView React component.
// Drives the real component against a stubbed `fetch` and asserts that
// populated card data renders and that every control's behavior fires the
// correct loopback request. The XR view reuses this exact export (see
// src/index.ts views[]), so the same component covers both viewTypes.

import {
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

describe("ViewManagerView (gui/xr) render", () => {
	it("renders the populated card grid with labels, paths, count, and status icons", async () => {
		const { calls } = stubFetch(({ url }) => {
			if (url === "/api/views") return jsonResponse(guiViews);
			throw new Error(`Unexpected request: ${url}`);
		});

		render(<ViewManagerView />);

		// Wait for the populated grid (both labels) to render.
		await screen.findByText("Wallet");
		expect(screen.getByText("Feed")).toBeTruthy();

		// Paths render as the subtitle for each card.
		expect(screen.getByText("/wallet")).toBeTruthy();
		expect(screen.getByText("/feed")).toBeTruthy();

		// Header count reflects views.length once loading completes.
		expect(screen.getByText("2")).toBeTruthy();

		// Available -> CheckCircle2 (aria-label Available); unavailable -> XCircle.
		expect(screen.getByLabelText("Available")).toBeTruthy();
		expect(screen.getByLabelText("Unavailable")).toBeTruthy();

		// Hero image src falls back to /api/views/<id>/hero when none provided.
		const heroImgs = document.querySelectorAll("img");
		const heroSrcs = Array.from(heroImgs).map((img) => img.getAttribute("src"));
		expect(heroSrcs).toContain("/api/views/wallet/hero");
		expect(heroSrcs).toContain("/api/views/feed/hero");

		// The GUI list fetch hits GET /api/views with NO query string.
		expect(calls[0].url).toBe("/api/views");
		expect(calls[0].init?.method ?? "GET").toBe("GET");
	});

	it("opens a card via POST navigate with NO ?viewType query string (gui distinction)", async () => {
		const { calls } = stubFetch(({ url }) => {
			if (url === "/api/views") return jsonResponse(guiViews);
			if (url === "/api/views/wallet/navigate")
				return jsonResponse({ ok: true });
			throw new Error(`Unexpected request: ${url}`);
		});

		render(<ViewManagerView />);
		const card = await screen.findByLabelText("Open Wallet");
		fireEvent.click(card);

		await waitFor(() => {
			const navCall = calls.find((c) => c.url.includes("/navigate"));
			expect(navCall).toBeTruthy();
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

	it("refresh button re-issues GET /api/views", async () => {
		const { calls } = stubFetch(({ url }) => {
			if (url === "/api/views") return jsonResponse(guiViews);
			throw new Error(`Unexpected request: ${url}`);
		});

		render(<ViewManagerView />);
		await screen.findByText("Wallet");
		expect(calls.filter((c) => c.url === "/api/views")).toHaveLength(1);

		fireEvent.click(screen.getByLabelText("Refresh views"));

		await waitFor(() => {
			expect(calls.filter((c) => c.url === "/api/views")).toHaveLength(2);
		});
	});

	it("renders the EmptyState ('No views') for an empty payload", async () => {
		stubFetch(({ url }) => {
			if (url === "/api/views") return jsonResponse({ views: [] });
			throw new Error(`Unexpected request: ${url}`);
		});

		render(<ViewManagerView />);
		await screen.findByText("No views");
		// No card buttons should be present.
		expect(screen.queryByLabelText(/^Open /)).toBeNull();
	});

	it("renders the error branch when the fetch resolves non-ok (HTTP 500)", async () => {
		stubFetch(({ url }) => {
			if (url === "/api/views")
				return jsonResponse({ error: "boom" }, { status: 500 });
			throw new Error(`Unexpected request: ${url}`);
		});

		render(<ViewManagerView />);
		await screen.findByText("HTTP 500");
		expect(screen.queryByText("No views")).toBeNull();
	});

	it("shows 'Loading views…' before the fetch resolves", async () => {
		let resolveFetch: ((r: Response) => void) | undefined;
		const pending = new Promise<Response>((r) => {
			resolveFetch = r;
		});
		const mock = vi.fn(async () => pending);
		vi.stubGlobal("fetch", mock);

		render(<ViewManagerView />);
		// Loading text is rendered synchronously before the promise resolves.
		expect(screen.getByText("Loading views…")).toBeTruthy();
		// The count span is hidden while loading.
		expect(screen.queryByText("2")).toBeNull();

		resolveFetch?.(jsonResponse(guiViews));
		await screen.findByText("Wallet");
	});

	it("XR reuses the same component and fetches the gui list (no viewType qs)", async () => {
		// The xr entry in src/index.ts uses componentExport "ViewManagerView" —
		// the exact export rendered here — and fetchViewEntries() is called with
		// no viewType, so the xr mount hits GET /api/views with no query string.
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
