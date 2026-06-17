// @vitest-environment jsdom
//
// FacewearXrView is a distinct component (Active/Standby pill, XR_DEVICE_LIMIT=6,
// dedicated empty-state, 3s poll) that is NOT wired to any view declaration: the
// xr `facewear` view's componentExport is "FacewearView" (see src/index.ts), and
// FacewearXrView is otherwise only string-checked by facewear-visual-copy.test.ts.
//
// This file (a) renders FacewearXrView and asserts its populated/empty data so
// the component's behavior is covered, and (b) asserts the manifest fact that the
// xr facewear view intentionally reuses FacewearView, flagging the mismatch.

import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { facewearPlugin } from "../index.ts";
import { FacewearXrView } from "../ui/FacewearXrView.tsx";

type ConnectedDevice = {
  id: string;
  kind: "xr" | "smartglasses";
  deviceType?: string;
};

type StatusBody = { connected: boolean; devices: ConnectedDevice[] };

function stubFetch(body: StatusBody): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        ({
          ok: true,
          status: 200,
          json: async () => body,
        }) as unknown as Response,
    ),
  );
}

async function renderResolved(): Promise<void> {
  render(<FacewearXrView />);
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
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

describe("FacewearXrView (standalone component)", () => {
  it("shows the Active pill and the connected device list when devices are present", async () => {
    stubFetch({
      connected: true,
      devices: [
        { id: "q1", kind: "xr", deviceType: "meta-quest" },
        { id: "sg", kind: "smartglasses", deviceType: "even-realities" },
      ],
    });
    await renderResolved();

    expect(screen.getByText("Active")).toBeTruthy();
    expect(screen.queryByText("Standby")).toBeNull();
    // Each device renders its deviceType label and a "Connected" sub-line.
    expect(screen.getByText("meta-quest")).toBeTruthy();
    expect(screen.getByText("even-realities")).toBeTruthy();
    expect(screen.getAllByText("Connected")).toHaveLength(2);
    expect(screen.queryByText("No devices")).toBeNull();
  });

  it("falls back to device.kind when deviceType is absent", async () => {
    stubFetch({
      connected: true,
      devices: [{ id: "sg", kind: "smartglasses" }],
    });
    await renderResolved();

    expect(screen.getByText("smartglasses")).toBeTruthy();
  });

  it("shows the Standby pill and the empty 'No devices' state when none are connected", async () => {
    stubFetch({ connected: false, devices: [] });
    await renderResolved();

    expect(screen.getByText("Standby")).toBeTruthy();
    expect(screen.queryByText("Active")).toBeNull();
    expect(screen.getByText("No devices")).toBeTruthy();
    expect(screen.getByText("Open Facewear to connect.")).toBeTruthy();
  });

  it("caps the device list at XR_DEVICE_LIMIT=6 with a '+N more connected' row", async () => {
    const devices: ConnectedDevice[] = Array.from({ length: 8 }, (_, i) => ({
      id: `d${i}`,
      kind: "xr",
      deviceType: `dev-${i}`,
    }));
    stubFetch({ connected: true, devices });
    await renderResolved();

    // 6 visible device labels; the 7th/8th are summarized.
    expect(screen.getByText("dev-0")).toBeTruthy();
    expect(screen.getByText("dev-5")).toBeTruthy();
    expect(screen.queryByText("dev-6")).toBeNull();
    expect(screen.getByText("+2 more connected")).toBeTruthy();
  });

  it("manifest fact: the xr `facewear` view reuses FacewearView, not FacewearXrView", () => {
    const xrFacewearView = facewearPlugin.views?.find(
      (view) => view.id === "facewear" && view.viewType === "xr",
    );
    expect(xrFacewearView).toBeTruthy();
    // Documented mismatch: FacewearXrView exists but is unregistered; the xr view
    // points at FacewearView. If this ever flips to "FacewearXrView", the
    // dedicated rendering coverage above becomes the live path.
    expect(xrFacewearView?.componentExport).toBe("FacewearView");
  });
});
