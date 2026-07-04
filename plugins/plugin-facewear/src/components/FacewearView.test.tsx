/**
 * @vitest-environment jsdom
 *
 * FacewearView tests drive the unified GUI/XR wrapper through device rows,
 * routing actions, connect/status controls, and refresh fetches.
 */

import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FacewearView } from "./FacewearView.tsx";

type ConnectedDevice = {
	id: string;
	kind: "xr" | "smartglasses";
	deviceType?: string;
};

type StatusBody = { connected: boolean; devices: ConnectedDevice[] };

function stubFetch(body: StatusBody): ReturnType<typeof vi.fn> {
	const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
		const url = String(input);
		if (url === "/api/facewear/xr-runtime") {
			return {
				ok: true,
				status: 200,
				json: async () => ({
					status: {
						installed: false,
						runtime: null,
						webxrReady: false,
						platform: "darwin",
					},
					plan: { steps: [] },
				}),
			} as unknown as Response;
		}
		return {
			ok: true,
			status: 200,
			json: async () => body,
		} as unknown as Response;
	});
	vi.stubGlobal("fetch", fetchMock);
	return fetchMock;
}

async function renderResolved(): Promise<void> {
	render(<FacewearView />);
	await act(async () => {
		await Promise.resolve();
		await Promise.resolve();
	});
}

function button(agentId: string): HTMLButtonElement {
	const el = document.querySelector(`[data-agent-id="${agentId}"]`);
	if (!el) throw new Error(`no element with data-agent-id="${agentId}"`);
	return el as HTMLButtonElement;
}

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
});

afterEach(() => {
	cleanup();
	vi.useRealTimers();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe("FacewearView — unified GUI/XR wrapper", () => {
	it("loads device profiles on mount and shows the connected header pill", async () => {
		const fetchMock = stubFetch({
			connected: true,
			devices: [{ id: "q1", kind: "xr", deviceType: "meta-quest" }],
		});
		await renderResolved();

		expect(fetchMock).toHaveBeenCalledWith("/api/facewear/status");
		expect(screen.getByText("1 device connected")).toBeTruthy();
		// All four supported profiles render as device rows.
		expect(screen.getByText("Meta Quest 3 / 3S / Pro")).toBeTruthy();
		expect(screen.getByText("Even Realities G1 / G2")).toBeTruthy();
	});

	it("routes even-realities Connect to the Smartglasses settings tab", async () => {
		stubFetch({ connected: false, devices: [] });
		await renderResolved();

		const dispatchSpy = vi.spyOn(window, "dispatchEvent");
		fireEvent.click(button("connect:even-realities"));
		expect(dispatchSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "wearables:select-tab",
				detail: "smartglasses",
			}),
		);
	});

	it("routes a WebXR profile Connect to window.open('/api/xr/connect')", async () => {
		stubFetch({ connected: false, devices: [] });
		await renderResolved();

		const openSpy = vi.fn();
		vi.stubGlobal("open", openSpy);
		fireEvent.click(button("connect:meta-quest"));
		expect(openSpy).toHaveBeenCalledWith(
			"/api/xr/connect",
			"_blank",
			"noopener,noreferrer",
		);
	});

	it("opens the XR connect and status pages via the quick-action buttons", async () => {
		stubFetch({ connected: false, devices: [] });
		await renderResolved();

		const openSpy = vi.fn();
		vi.stubGlobal("open", openSpy);
		fireEvent.click(button("xr-connect"));
		fireEvent.click(button("xr-status"));
		expect(openSpy).toHaveBeenNthCalledWith(
			1,
			"/api/xr/connect",
			"_blank",
			"noopener,noreferrer",
		);
		expect(openSpy).toHaveBeenNthCalledWith(
			2,
			"/api/xr/status",
			"_blank",
			"noopener,noreferrer",
		);
	});

	it("re-fetches status and runtime when Refresh is clicked", async () => {
		const fetchMock = stubFetch({ connected: false, devices: [] });
		await renderResolved();
		const statusCalls = () =>
			fetchMock.mock.calls.filter(([input]) => input === "/api/facewear/status")
				.length;
		const runtimeCalls = () =>
			fetchMock.mock.calls.filter(
				([input]) => input === "/api/facewear/xr-runtime",
			).length;
		const beforeStatus = statusCalls();
		const beforeRuntime = runtimeCalls();
		expect(beforeStatus).toBeGreaterThanOrEqual(1);
		expect(beforeRuntime).toBeGreaterThanOrEqual(1);

		await act(async () => {
			fireEvent.click(button("refresh"));
			await Promise.resolve();
		});

		expect(statusCalls()).toBe(beforeStatus + 1);
		expect(runtimeCalls()).toBe(beforeRuntime + 1);
	});

	it("renders the error banner when the status fetch rejects", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new Error("network down");
			}),
		);
		await renderResolved();
		expect(screen.getByText("network down")).toBeTruthy();
	});
});
