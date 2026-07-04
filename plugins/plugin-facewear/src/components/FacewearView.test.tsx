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
  const fetchMock = vi.fn(
    async () =>
      ({
        ok: true,
        status: 200,
        json: async () => body,
      }) as unknown as Response,
  );
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

  it("routes even-realities Connect to /apps/smartglasses via window.location.assign", async () => {
    stubFetch({ connected: false, devices: [] });
    await renderResolved();

    const assign = vi.fn();
    vi.stubGlobal("location", { assign } as unknown as Location);
    fireEvent.click(button("connect:even-realities"));
    expect(assign).toHaveBeenCalledWith("/apps/smartglasses");
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

  it("re-fetches status when Refresh is clicked, always hitting the status endpoint", async () => {
    const fetchMock = stubFetch({ connected: false, devices: [] });
    await renderResolved();
    const before = fetchMock.mock.calls.length;
    expect(before).toBeGreaterThanOrEqual(1);

    await act(async () => {
      fireEvent.click(button("refresh"));
      await Promise.resolve();
    });

    expect(fetchMock.mock.calls.length).toBe(before + 1);
    for (const call of fetchMock.mock.calls) {
      expect(call[0]).toBe("/api/facewear/status");
    }
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
