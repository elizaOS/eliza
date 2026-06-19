// @vitest-environment jsdom
//
// Renders the real FacewearView component (the gui + xr `facewear` view; the xr
// manifest reuses this same component export) against a stubbed
// /api/facewear/status response and asserts the populated device grid, the
// header pill, the active-device chip overflow, loading/error states, and every
// interactive control (Connect/Manage routing, Refresh re-fetch, quick-action
// anchor hrefs).

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FacewearView } from "../ui/FacewearView.tsx";

type ConnectedDevice = {
  id: string;
  kind: "xr" | "smartglasses";
  deviceType?: string;
};

type StatusBody = { connected: boolean; devices: ConnectedDevice[] };

function jsonResponse(body: StatusBody): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  } as unknown as Response;
}

function stubFetch(body: StatusBody): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async () => jsonResponse(body));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

// Render then let the initial fetch + useEffect resolve so the loading spinner
// is replaced by the populated UI.
async function renderResolved(): Promise<void> {
  render(<FacewearView />);
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

describe("FacewearView (gui/xr facewear view)", () => {
  it("renders all four device profiles with exact name/manufacturer/connection-type", async () => {
    stubFetch({ connected: false, devices: [] });
    await renderResolved();

    // Names (each card's title)
    expect(screen.getByText("Meta Quest 3 / 3S / Pro")).toBeTruthy();
    expect(screen.getByText("XReal Air 3 / One Pro")).toBeTruthy();
    expect(screen.getByText("Even Realities G1 / G2")).toBeTruthy();
    expect(screen.getByText("Apple Vision Pro")).toBeTruthy();

    // Manufacturers
    expect(screen.getByText("Meta")).toBeTruthy();
    expect(screen.getByText("XREAL")).toBeTruthy();
    expect(screen.getByText("Even Realities")).toBeTruthy();
    expect(screen.getByText("Apple")).toBeTruthy();

    // Connection-type labels: 3 x WebXR, 1 x Bluetooth BLE
    expect(screen.getAllByText("WebXR")).toHaveLength(3);
    expect(screen.getByText("Bluetooth BLE")).toBeTruthy();

    // Descriptions
    expect(screen.getByText("Passthrough AR/VR")).toBeTruthy();
    expect(screen.getByText("OLED display and mic")).toBeTruthy();
  });

  it("shows the empty header pill when no devices are connected", async () => {
    stubFetch({ connected: false, devices: [] });
    await renderResolved();

    expect(screen.getByText("No devices connected")).toBeTruthy();
    // Every card resting state -> Disconnected + a "Connect <name>" button.
    // (The "Connect" quick-action is an <a>, so scope to card buttons by label.)
    expect(screen.getAllByText("Disconnected")).toHaveLength(4);
    expect(screen.getAllByRole("button", { name: /^Connect / })).toHaveLength(
      4,
    );
    expect(screen.queryAllByRole("button", { name: /^Manage / })).toHaveLength(
      0,
    );
    // No active-device chip row when there are zero devices.
    expect(screen.queryByText(/^\+\d+$/)).toBeNull();
  });

  it("derives per-card connected state: deviceType match, even-realities->smartglasses, WebXR->xr", async () => {
    // meta-quest matches by deviceType; even-realities matches via kind=smartglasses.
    // xreal + apple-vision-pro are NOT connected (no matching xr/deviceType here
    // because the only xr device declares deviceType meta-quest which the xreal
    // card's WebXR->xr rule would ALSO match — so use a smartglasses + a
    // non-xr-kind device to isolate the deviceType-exact + smartglasses rules).
    stubFetch({
      connected: true,
      devices: [
        { id: "q1", kind: "xr", deviceType: "meta-quest" },
        { id: "sg", kind: "smartglasses", deviceType: "even-realities" },
      ],
    });
    await renderResolved();

    // The WebXR->xr rule connects ALL three WebXR cards because one xr device is
    // present (the rule matches profile.connectionType === "WebXR" && d.kind === "xr").
    // So meta-quest, xreal, apple-vision-pro all read Connected; even-realities
    // reads Connected via the smartglasses rule. => all 4 connected.
    expect(screen.getAllByText("Connected")).toHaveLength(4);
    expect(screen.getAllByText("Manage")).toHaveLength(4);
    expect(screen.queryByText("Disconnected")).toBeNull();
  });

  it("connects only smartglasses-rule cards when the device list has no xr-kind device", async () => {
    // Only a smartglasses device -> even-realities card Connected (kind rule),
    // the three WebXR cards stay Disconnected (no xr-kind device present).
    stubFetch({
      connected: true,
      devices: [
        { id: "sg", kind: "smartglasses", deviceType: "even-realities" },
      ],
    });
    await renderResolved();

    // even-realities card -> Connected/Manage; the 3 WebXR cards -> Disconnected/Connect.
    expect(screen.getAllByText("Connected")).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: /^Manage / })).toHaveLength(1);
    expect(screen.getAllByText("Disconnected")).toHaveLength(3);
    expect(screen.getAllByRole("button", { name: /^Connect / })).toHaveLength(
      3,
    );
  });

  it("renders the plural header pill and active-device chips for multiple devices", async () => {
    stubFetch({
      connected: true,
      devices: [
        { id: "q1", kind: "xr", deviceType: "meta-quest" },
        { id: "x1", kind: "xr", deviceType: "xreal" },
      ],
    });
    await renderResolved();

    expect(screen.getByText("2 devices connected")).toBeTruthy();
    // Active-device chips show device.deviceType for each (within the chip row).
    expect(screen.getByText("meta-quest")).toBeTruthy();
    expect(screen.getByText("xreal")).toBeTruthy();
  });

  it("renders the singular header pill for exactly one device", async () => {
    stubFetch({
      connected: true,
      devices: [{ id: "q1", kind: "xr", deviceType: "meta-quest" }],
    });
    await renderResolved();

    expect(screen.getByText("1 device connected")).toBeTruthy();
    expect(screen.queryByText(/devices connected/)).toBeNull();
  });

  it("caps the active-device chip row at ACTIVE_DEVICE_LIMIT=4 with a +N overflow chip", async () => {
    stubFetch({
      connected: true,
      devices: [
        { id: "a", kind: "xr", deviceType: "meta-quest" },
        { id: "b", kind: "xr", deviceType: "xreal" },
        { id: "c", kind: "xr", deviceType: "apple-vision-pro" },
        { id: "d", kind: "smartglasses", deviceType: "even-realities" },
        { id: "e", kind: "xr", deviceType: "meta-quest" },
        { id: "f", kind: "xr", deviceType: "xreal" },
      ],
    });
    await renderResolved();

    expect(screen.getByText("6 devices connected")).toBeTruthy();
    // Overflow chip shows +2 (6 devices - 4 visible).
    expect(screen.getByText("+2")).toBeTruthy();
  });

  it("shows the loading spinner before the initial fetch resolves and hides cards", () => {
    // Never-resolving fetch so loading stays true.
    const pending = new Promise<Response>(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn(() => pending),
    );
    const { container } = render(<FacewearView />);

    // Spinner present; device cards not yet rendered.
    expect(container.querySelector(".animate-spin")).toBeTruthy();
    expect(screen.queryByText("Meta Quest 3 / 3S / Pro")).toBeNull();
  });

  it("shows an error banner with the fetch error message when the fetch rejects", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );
    await renderResolved();

    expect(screen.getByText("network down")).toBeTruthy();
  });

  it("routes even-realities Connect/Manage to /apps/smartglasses via window.location.assign", async () => {
    stubFetch({ connected: false, devices: [] });
    await renderResolved();

    const assign = vi.fn();
    vi.stubGlobal("location", { assign } as unknown as Location);

    // The even-realities card's button is the one labeled "Connect Even Realities G1 / G2".
    const evenButton = screen.getByRole("button", {
      name: "Connect Even Realities G1 / G2",
    });
    fireEvent.click(evenButton);

    expect(assign).toHaveBeenCalledWith("/apps/smartglasses");
  });

  it("routes a WebXR card Connect to window.open('/api/xr/connect')", async () => {
    stubFetch({ connected: false, devices: [] });
    await renderResolved();

    const openSpy = vi.fn();
    vi.stubGlobal("open", openSpy);

    const metaButton = screen.getByRole("button", {
      name: "Connect Meta Quest 3 / 3S / Pro",
    });
    fireEvent.click(metaButton);

    expect(openSpy).toHaveBeenCalledWith(
      "/api/xr/connect",
      "_blank",
      "noopener,noreferrer",
    );
  });

  it("re-fetches status when the Refresh button is clicked", async () => {
    const fetchMock = stubFetch({ connected: false, devices: [] });
    await renderResolved();

    const callsAfterMount = fetchMock.mock.calls.length;
    expect(callsAfterMount).toBeGreaterThanOrEqual(1);

    const refresh = screen.getByRole("button", { name: "Refresh" });
    await act(async () => {
      fireEvent.click(refresh);
      await Promise.resolve();
    });

    expect(fetchMock.mock.calls.length).toBe(callsAfterMount + 1);
    // Every call hits the documented status endpoint.
    for (const call of fetchMock.mock.calls) {
      expect(call[0]).toBe("/api/facewear/status");
    }
  });

  it("exposes quick-action anchors pointing at /api/xr/connect and /api/xr/status", async () => {
    stubFetch({ connected: false, devices: [] });
    await renderResolved();

    const connect = screen.getByRole("link", { name: "XR connect" });
    const status = screen.getByRole("link", { name: "XR status" });
    expect(connect.getAttribute("href")).toBe("/api/xr/connect");
    expect(status.getAttribute("href")).toBe("/api/xr/status");
  });
});
