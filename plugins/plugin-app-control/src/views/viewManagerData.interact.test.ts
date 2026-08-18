/**
 * Interact capability tests for listing and opening view-manager entries.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
	getViewEntriesWithFetch,
	interact,
	VIEW_MANAGER_LIST_FETCH_TIMEOUT_MS,
} from "./viewManagerData";

const viewList = {
	views: [
		{
			id: "wallet",
			label: "Wallet",
			viewType: "gui",
			path: "/wallet",
			available: true,
			pluginName: "@elizaos/plugin-wallet:ui",
		},
		{
			id: "messages",
			label: "Messages",
			viewType: "gui",
			path: "/messages",
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
	it("list-views returns the available view list", async () => {
		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			expect(String(input)).toBe("/api/views");
			return jsonResponse(viewList);
		});
		vi.stubGlobal("fetch", fetchMock);

		await expect(interact("list-views")).resolves.toEqual(viewList);
		expect(fetchMock).toHaveBeenCalledOnce();
	});

	it("open-view navigates the matched view and reports its viewType", async () => {
		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url === "/api/views") return jsonResponse(viewList);
			if (url === "/api/views/messages/navigate?viewType=gui")
				return jsonResponse({ ok: true });
			throw new Error(`Unexpected request: ${url}`);
		});
		vi.stubGlobal("fetch", fetchMock);

		await expect(
			interact("open-view", { viewId: "messages" }),
		).resolves.toEqual({
			opened: true,
			viewId: "messages",
			viewType: "gui",
		});
		expect(fetchMock).toHaveBeenCalledWith(
			"/api/views/messages/navigate?viewType=gui",
			expect.objectContaining({
				method: "POST",
				credentials: "include",
				body: JSON.stringify({ path: "/messages", viewType: "gui" }),
			}),
		);
	});
});

describe("interact() error paths", () => {
	it("rejects a malformed registry payload instead of fabricating an empty list", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => jsonResponse({ status: "ready" })),
		);

		await expect(interact("list-views")).rejects.toMatchObject({
			name: "ElizaError",
			code: "VIEW_MANAGER_LIST_RESPONSE_INVALID",
			message: "GET /api/views response must contain a views array",
		});
	});

	it("open-view rejects with 'viewId is required' when viewId is missing", async () => {
		// No fetch should be needed before the guard fires; stub defensively.
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => jsonResponse(viewList)),
		);
		await expect(interact("open-view")).rejects.toThrow("viewId is required");
		await expect(interact("open-view", { viewId: "" })).rejects.toThrow(
			"viewId is required",
		);
		await expect(
			interact("open-view", { viewId: 42 as unknown as string }),
		).rejects.toThrow("viewId is required");
	});

	it("open-view rejects with 'View \"x\" not found' for an unknown viewId", async () => {
		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			if (String(input) === "/api/views") return jsonResponse(viewList);
			throw new Error(`Unexpected request: ${String(input)}`);
		});
		vi.stubGlobal("fetch", fetchMock);

		await expect(interact("open-view", { viewId: "ghost" })).rejects.toThrow(
			'View "ghost" not found',
		);
		expect(fetchMock).toHaveBeenCalledWith(
			"/api/views",
			expect.objectContaining({ signal: expect.any(AbortSignal) }),
		);
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

function stallUntilAborted() {
	return vi.fn(
		(_input: string, init?: RequestInit) =>
			new Promise<Response>((_resolve, reject) => {
				const signal = init?.signal;
				if (!signal) throw new Error("expected view-manager abort signal");
				signal.addEventListener("abort", () => reject(signal.reason), {
					once: true,
				});
			}),
	);
}

describe("view-manager list request deadline", () => {
	it("keeps a documented UI fetch budget", () => {
		expect(VIEW_MANAGER_LIST_FETCH_TIMEOUT_MS).toBe(15_000);
	});

	it("aborts a stalled /api/views GET at the injected deadline", async () => {
		const fetchImpl = stallUntilAborted();
		await expect(
			getViewEntriesWithFetch(undefined, fetchImpl, 10),
		).rejects.toMatchObject({ name: "TimeoutError" });
		expect(fetchImpl).toHaveBeenCalledWith(
			"/api/views",
			expect.objectContaining({ signal: expect.any(AbortSignal) }),
			{ timeoutMs: 10 },
		);
	});

	it("keeps the deadline active while the response body stalls", async () => {
		const fetchImpl = vi.fn(async (_input: string, init?: RequestInit) => {
			const signal = init?.signal;
			if (!signal) throw new Error("expected view-manager abort signal");
			return {
				ok: true,
				status: 200,
				json: () =>
					new Promise((_resolve, reject) => {
						signal.addEventListener("abort", () => reject(signal.reason), {
							once: true,
						});
					}),
			} as Response;
		});
		await expect(
			getViewEntriesWithFetch(undefined, fetchImpl, 10),
		).rejects.toMatchObject({ name: "TimeoutError" });
	});

	it("surfaces a provider error from a completed /api/views GET", async () => {
		const fetchImpl = async () =>
			new Response("nope", { status: 503, statusText: "Service Unavailable" });
		await expect(
			getViewEntriesWithFetch(undefined, fetchImpl, 1_000),
		).rejects.toMatchObject({
			name: "ElizaError",
			message: "GET /api/views returned HTTP 503",
		});
	});

	it("uses the injected fetch for a successful /api/views GET", async () => {
		const signals: AbortSignal[] = [];
		const fetchImpl = vi.fn(async (_input: string, init?: RequestInit) => {
			if (init?.signal) signals.push(init.signal);
			return jsonResponse(viewList);
		});
		const entries = await getViewEntriesWithFetch(undefined, fetchImpl, 1_000);
		expect(signals).toHaveLength(1);
		expect(signals[0]?.aborted).toBe(false);
		expect(entries.map((entry) => entry.id)).toEqual(["wallet", "messages"]);
		expect(fetchImpl).toHaveBeenCalledWith("/api/views", expect.any(Object), {
			timeoutMs: 1_000,
		});
	});
});
