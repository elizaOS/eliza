// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const wifiBridge = vi.hoisted(() => ({
  getWifiState: vi.fn(),
  getConnectedNetwork: vi.fn(),
  listAvailableNetworks: vi.fn(),
  connectToNetwork: vi.fn(),
  disconnectFromNetwork: vi.fn(),
}));

const systemBridge = vi.hoisted(() => ({
  openNetworkSettings: vi.fn(),
}));

vi.mock("@elizaos/capacitor-wifi", () => ({
  WiFi: wifiBridge,
}));

vi.mock("@elizaos/capacitor-system", () => ({
  System: systemBridge,
}));

vi.mock("@elizaos/ui", () => ({
  Button: ({
    children,
    type = "button",
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement>) =>
    // biome-ignore lint/a11y/useButtonType: test mock supplies an explicit default type.
    React.createElement("button", { type, ...props }, children),
  Input: (props: React.InputHTMLAttributes<HTMLInputElement>) =>
    React.createElement("input", props),
}));

import { WifiAppView } from "./WifiAppView";

const t = (_key: string, opts?: { defaultValue?: string }) =>
  opts?.defaultValue ?? "";

function overlayContext(exitToApps = vi.fn()) {
  return { exitToApps, uiTheme: "light" as const, t };
}

/**
 * Real-shaped @elizaos/capacitor-wifi WiFiNetwork (matches definitions.ts —
 * includes the `capabilities` field the view/provider drop). Used as the source
 * of truth for every render fixture so tests exercise the genuine API shape.
 */
function network(over: Partial<WifiNet> = {}): WifiNet {
  return {
    ssid: "FixtureNet",
    bssid: "aa:bb:cc:dd:ee:00",
    rssi: -55,
    frequency: 5180,
    capabilities: "[WPA2-PSK-CCMP][ESS]",
    secured: true,
    ...over,
  };
}

interface WifiNet {
  ssid: string;
  bssid: string;
  rssi: number;
  frequency: number;
  capabilities: string;
  secured: boolean;
}

/** Default: Wi-Fi on, not connected, empty scan. Tests override per-case. */
function mockDefaults() {
  wifiBridge.getWifiState.mockResolvedValue({
    enabled: true,
    connected: false,
    rssi: null,
  });
  wifiBridge.getConnectedNetwork.mockResolvedValue({ network: null });
  wifiBridge.listAvailableNetworks.mockResolvedValue({ networks: [] });
  wifiBridge.connectToNetwork.mockResolvedValue({ success: true });
  wifiBridge.disconnectFromNetwork.mockResolvedValue({ success: true });
  systemBridge.openNetworkSettings.mockResolvedValue(undefined);
}

function renderView(exitToApps = vi.fn()) {
  return render(React.createElement(WifiAppView, overlayContext(exitToApps)));
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("WifiAppView — connected card", () => {
  it("renders the connected network with ssid, rssi/frequency line, full SignalBars, and Disconnect", async () => {
    mockDefaults();
    wifiBridge.getWifiState.mockResolvedValue({
      enabled: true,
      connected: true,
      rssi: -55,
    });
    wifiBridge.getConnectedNetwork.mockResolvedValue({
      network: network({ ssid: "HomeNet", rssi: -55, frequency: 5180 }),
    });

    renderView();

    expect(await screen.findByText("Connected")).toBeTruthy();
    expect(screen.getByText("HomeNet")).toBeTruthy();
    expect(screen.getByText(/-55 dBm · 5180 MHz/)).toBeTruthy();
    // -55 dBm >= -60 but < -50 → 3 bars on the connected card row.
    expect(screen.getByLabelText("Signal 3 of 4")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Disconnect" })).toBeTruthy();
  });

  it("shows '(hidden)' when the connected ssid is empty", async () => {
    mockDefaults();
    wifiBridge.getWifiState.mockResolvedValue({
      enabled: true,
      connected: true,
      rssi: -48,
    });
    wifiBridge.getConnectedNetwork.mockResolvedValue({
      network: network({ ssid: "", rssi: -48 }),
    });

    renderView();

    expect(await screen.findByText("Connected")).toBeTruthy();
    expect(screen.getByText("(hidden)")).toBeTruthy();
    // -48 dBm >= -50 → 4 bars.
    expect(screen.getByLabelText("Signal 4 of 4")).toBeTruthy();
  });

  it("renders the Wi-Fi-off state and routes its Network settings button to System.openNetworkSettings", async () => {
    mockDefaults();
    wifiBridge.getWifiState.mockResolvedValue({
      enabled: false,
      connected: false,
      rssi: null,
    });

    renderView();

    expect(await screen.findByText("Wi-Fi is off")).toBeTruthy();
    expect(screen.getByText("Enable it in Android settings.")).toBeTruthy();

    // Wi-Fi-off + empty scan renders two "Network settings" buttons (the
    // connected card and the empty state). Both route to openNetworkSettings;
    // click the connected-card one (first match).
    const settingsButtons = screen.getAllByRole("button", {
      name: /Network settings/,
    });
    expect(settingsButtons.length).toBeGreaterThanOrEqual(1);
    fireEvent.click(settingsButtons[0]);
    await waitFor(() =>
      expect(systemBridge.openNetworkSettings).toHaveBeenCalledTimes(1),
    );
  });

  it("renders the not-connected state when Wi-Fi is on but no network is active", async () => {
    mockDefaults();
    wifiBridge.getWifiState.mockResolvedValue({
      enabled: true,
      connected: false,
      rssi: null,
    });
    wifiBridge.getConnectedNetwork.mockResolvedValue({ network: null });

    renderView();

    expect(await screen.findByText("Not connected")).toBeTruthy();
  });
});

describe("WifiAppView — network list", () => {
  it("sorts networks by descending rssi, slices to 12, shows '13 / 12 shown', and renders per-row data", async () => {
    mockDefaults();
    // 13 networks with rssi out of order so sort is observable.
    const rssis = [
      -90, -41, -73, -55, -88, -62, -47, -79, -51, -67, -84, -58, -70,
    ];
    const nets = rssis.map((rssi, i) =>
      network({
        ssid: `Net${i}`,
        bssid: `aa:bb:cc:dd:ee:${i.toString(16).padStart(2, "0")}`,
        rssi,
        secured: i % 2 === 0,
      }),
    );
    wifiBridge.listAvailableNetworks.mockResolvedValue({ networks: nets });

    renderView();

    // Count badge for >12 networks.
    expect(await screen.findByText("13 / 12 shown")).toBeTruthy();

    // Exactly 12 rows rendered (the 13th is sliced off).
    const rows = screen
      .getAllByRole("button")
      .filter((b) =>
        b.getAttribute("data-testid")?.startsWith("wifi-network-"),
      );
    expect(rows).toHaveLength(12);

    // Descending rssi: read each row's "<bssid> · <rssi> dBm" line and parse the dBm.
    const rowRssis = rows.map((row) => {
      const m = row.textContent?.match(/(-?\d+) dBm/);
      return m ? Number(m[1]) : Number.NaN;
    });
    const sortedDesc = [...rowRssis].sort((a, b) => b - a);
    expect(rowRssis).toEqual(sortedDesc);
    // Strongest (-41) first, weakest visible is the 12th-strongest (-88); -90 dropped.
    expect(rowRssis[0]).toBe(-41);
    expect(rowRssis).not.toContain(-90);

    // The -41 network is Net1 (index 1), which is secured:false (odd index) → Wifi icon, open.
    // Verify a specific row's ssid/bssid/rssi text is present.
    const strongest = screen.getByTestId("wifi-network-aa:bb:cc:dd:ee:01");
    expect(within(strongest).getByText("Net1")).toBeTruthy();
    expect(
      within(strongest).getByText("aa:bb:cc:dd:ee:01 · -41 dBm"),
    ).toBeTruthy();
  });

  it("renders Lock for secured rows and Wifi icon for open rows, with correct SignalBars per row", async () => {
    mockDefaults();
    wifiBridge.listAvailableNetworks.mockResolvedValue({
      networks: [
        network({
          ssid: "SecuredNet",
          bssid: "11:11:11:11:11:11",
          rssi: -45,
          secured: true,
        }),
        network({
          ssid: "OpenNet",
          bssid: "22:22:22:22:22:22",
          rssi: -78,
          secured: false,
        }),
      ],
    });

    renderView();

    const secured = await screen.findByTestId("wifi-network-11:11:11:11:11:11");
    const open = screen.getByTestId("wifi-network-22:22:22:22:22:22");

    // Secured row: lucide Lock icon present, lucide Wifi icon absent.
    expect(secured.querySelector(".lucide-lock")).toBeTruthy();
    expect(secured.querySelector(".lucide-wifi")).toBeNull();
    // -45 >= -50 → 4 bars.
    expect(within(secured).getByLabelText("Signal 4 of 4")).toBeTruthy();

    // Open row: lucide Wifi icon present, Lock absent.
    expect(open.querySelector(".lucide-wifi")).toBeTruthy();
    expect(open.querySelector(".lucide-lock")).toBeNull();
    // -78 dBm: >= -80 but < -70 → 1 bar.
    expect(within(open).getByLabelText("Signal 1 of 4")).toBeTruthy();
  });

  it("renders the empty state with Scan again + Network settings once a scan settles with zero networks", async () => {
    mockDefaults();
    wifiBridge.listAvailableNetworks.mockResolvedValue({ networks: [] });

    renderView();

    expect(await screen.findByText("None")).toBeTruthy();
    expect(screen.getByText("Check Wi-Fi and location access.")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Scan again/ })).toBeTruthy();
    expect(
      screen.getAllByRole("button", { name: /Network settings/ }).length,
    ).toBeGreaterThanOrEqual(1);
  });

  it("uses a plain '5' count badge (no '/ 12 shown') when 12 or fewer networks are present", async () => {
    mockDefaults();
    wifiBridge.listAvailableNetworks.mockResolvedValue({
      networks: [-40, -50, -60, -70, -80].map((rssi, i) =>
        network({ ssid: `N${i}`, bssid: `00:00:00:00:00:0${i}`, rssi }),
      ),
    });

    renderView();

    expect(await screen.findByText("N0")).toBeTruthy();
    expect(screen.getByText("5")).toBeTruthy();
    expect(screen.queryByText(/shown/)).toBeNull();
  });
});

describe("WifiAppView — signalBars threshold mapping", () => {
  it.each([
    { rssi: -50, bars: 4 },
    { rssi: -49, bars: 4 },
    { rssi: -60, bars: 3 },
    { rssi: -59, bars: 3 },
    { rssi: -70, bars: 2 },
    { rssi: -69, bars: 2 },
    { rssi: -80, bars: 1 },
    { rssi: -79, bars: 1 },
    { rssi: -81, bars: 0 },
    { rssi: -100, bars: 0 },
  ])("maps $rssi dBm to $bars bars", async ({ rssi, bars }) => {
    mockDefaults();
    wifiBridge.listAvailableNetworks.mockResolvedValue({
      networks: [network({ ssid: "T", bssid: "ab:ab:ab:ab:ab:ab", rssi })],
    });

    renderView();

    const row = await screen.findByTestId("wifi-network-ab:ab:ab:ab:ab:ab");
    expect(within(row).getByLabelText(`Signal ${bars} of 4`)).toBeTruthy();
  });
});

describe("WifiAppView — controls", () => {
  it("auto-scans on mount with limit 50", async () => {
    mockDefaults();
    renderView();
    await waitFor(() =>
      expect(wifiBridge.listAvailableNetworks).toHaveBeenCalledWith({
        limit: 50,
      }),
    );
  });

  it("re-scans and disables the Scan button while a scan is pending", async () => {
    mockDefaults();
    // First (auto) scan resolves immediately so the view settles.
    wifiBridge.listAvailableNetworks.mockResolvedValueOnce({ networks: [] });
    renderView();

    await waitFor(() =>
      expect(wifiBridge.listAvailableNetworks).toHaveBeenCalledTimes(1),
    );

    // Second scan: hold the promise open to observe the disabled/spinning state.
    let resolveScan: (v: { networks: WifiNet[] }) => void = () => {};
    wifiBridge.listAvailableNetworks.mockReturnValueOnce(
      new Promise((res) => {
        resolveScan = res;
      }),
    );

    const scanBtn = screen.getByTestId("wifi-scan");
    fireEvent.click(scanBtn);

    await waitFor(() =>
      expect(wifiBridge.listAvailableNetworks).toHaveBeenCalledTimes(2),
    );
    await waitFor(() =>
      expect((scanBtn as HTMLButtonElement).disabled).toBe(true),
    );
    // Spinner class applied while scanning.
    expect(scanBtn.querySelector(".animate-spin")).toBeTruthy();

    resolveScan({ networks: [] });
    await waitFor(() =>
      expect((scanBtn as HTMLButtonElement).disabled).toBe(false),
    );
  });

  it("Back button calls exitToApps exactly once", async () => {
    mockDefaults();
    const exitToApps = vi.fn();
    renderView(exitToApps);

    fireEvent.click(
      await screen.findByRole("button", { name: "Back to apps" }),
    );
    expect(exitToApps).toHaveBeenCalledTimes(1);
  });

  it("selecting a secured row opens the connect drawer with a password input", async () => {
    mockDefaults();
    wifiBridge.listAvailableNetworks.mockResolvedValue({
      networks: [
        network({
          ssid: "SecuredNet",
          bssid: "11:11:11:11:11:11",
          rssi: -50,
          secured: true,
        }),
      ],
    });

    renderView();

    fireEvent.click(
      await screen.findByTestId("wifi-network-11:11:11:11:11:11"),
    );

    expect(await screen.findByText("Connect to")).toBeTruthy();
    // SecuredNet appears twice once the drawer opens: the row label and the
    // drawer's bold target span. Both must be present.
    expect(screen.getAllByText("SecuredNet").length).toBeGreaterThanOrEqual(2);
    const pw = document.querySelector(
      'input[type="password"]',
    ) as HTMLInputElement | null;
    expect(pw).toBeTruthy();
    expect(screen.getByRole("button", { name: "Connect" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
  });

  it("connects to a secured network with the typed password, then clears + refreshes state", async () => {
    mockDefaults();
    wifiBridge.listAvailableNetworks.mockResolvedValue({
      networks: [
        network({
          ssid: "SecuredNet",
          bssid: "11:11:11:11:11:11",
          rssi: -50,
          secured: true,
        }),
      ],
    });
    wifiBridge.connectToNetwork.mockResolvedValue({ success: true });

    renderView();

    fireEvent.click(
      await screen.findByTestId("wifi-network-11:11:11:11:11:11"),
    );
    const pw = (await waitFor(() => {
      const el = document.querySelector('input[type="password"]');
      if (!el) throw new Error("no password input");
      return el;
    })) as HTMLInputElement;
    fireEvent.change(pw, { target: { value: "hunter2" } });

    // refreshState is called once on mount; reset the call count to assert the
    // post-connect refresh distinctly.
    wifiBridge.getConnectedNetwork.mockClear();

    fireEvent.click(screen.getByRole("button", { name: "Connect" }));

    await waitFor(() =>
      expect(wifiBridge.connectToNetwork).toHaveBeenCalledWith({
        ssid: "SecuredNet",
        password: "hunter2",
      }),
    );
    // Drawer closes on success.
    await waitFor(() => expect(screen.queryByText("Connect to")).toBeNull());
    // refreshState re-queried (getConnectedNetwork called again after connect).
    expect(wifiBridge.getConnectedNetwork).toHaveBeenCalled();
  });

  it("connects to an open network with password:undefined and shows no password input", async () => {
    mockDefaults();
    wifiBridge.listAvailableNetworks.mockResolvedValue({
      networks: [
        network({
          ssid: "OpenNet",
          bssid: "22:22:22:22:22:22",
          rssi: -50,
          secured: false,
        }),
      ],
    });
    wifiBridge.connectToNetwork.mockResolvedValue({ success: true });

    renderView();

    fireEvent.click(
      await screen.findByTestId("wifi-network-22:22:22:22:22:22"),
    );
    await screen.findByText("Connect to");
    // No password input for open networks.
    expect(document.querySelector('input[type="password"]')).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Connect" }));

    await waitFor(() =>
      expect(wifiBridge.connectToNetwork).toHaveBeenCalledWith({
        ssid: "OpenNet",
        password: undefined,
      }),
    );
  });

  it("surfaces a failed connect message in the error banner and keeps the drawer open", async () => {
    mockDefaults();
    wifiBridge.listAvailableNetworks.mockResolvedValue({
      networks: [
        network({
          ssid: "SecuredNet",
          bssid: "11:11:11:11:11:11",
          rssi: -50,
          secured: true,
        }),
      ],
    });
    wifiBridge.connectToNetwork.mockResolvedValue({
      success: false,
      message: "bad password",
    });

    renderView();

    fireEvent.click(
      await screen.findByTestId("wifi-network-11:11:11:11:11:11"),
    );
    const pw = (await waitFor(() => {
      const el = document.querySelector('input[type="password"]');
      if (!el) throw new Error("no password input");
      return el;
    })) as HTMLInputElement;
    fireEvent.change(pw, { target: { value: "wrong" } });

    fireEvent.click(screen.getByRole("button", { name: "Connect" }));

    expect(await screen.findByText("bad password")).toBeTruthy();
    // Drawer stays open after a failed connect.
    expect(screen.getByText("Connect to")).toBeTruthy();
  });

  it("Cancel clears the drawer and the typed password", async () => {
    mockDefaults();
    wifiBridge.listAvailableNetworks.mockResolvedValue({
      networks: [
        network({
          ssid: "SecuredNet",
          bssid: "11:11:11:11:11:11",
          rssi: -50,
          secured: true,
        }),
      ],
    });

    renderView();

    fireEvent.click(
      await screen.findByTestId("wifi-network-11:11:11:11:11:11"),
    );
    const pw = (await waitFor(() => {
      const el = document.querySelector('input[type="password"]');
      if (!el) throw new Error("no password input");
      return el;
    })) as HTMLInputElement;
    fireEvent.change(pw, { target: { value: "typed" } });
    expect(pw.value).toBe("typed");

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByText("Connect to")).toBeNull());

    // Reopen — password must have been reset.
    fireEvent.click(screen.getByTestId("wifi-network-11:11:11:11:11:11"));
    const reopened = (await waitFor(() => {
      const el = document.querySelector('input[type="password"]');
      if (!el) throw new Error("no password input");
      return el;
    })) as HTMLInputElement;
    expect(reopened.value).toBe("");
  });

  it("Disconnect calls disconnectFromNetwork then refreshes state", async () => {
    mockDefaults();
    wifiBridge.getWifiState.mockResolvedValue({
      enabled: true,
      connected: true,
      rssi: -55,
    });
    wifiBridge.getConnectedNetwork.mockResolvedValue({
      network: network({ ssid: "HomeNet", rssi: -55 }),
    });
    wifiBridge.disconnectFromNetwork.mockResolvedValue({ success: true });

    renderView();

    await screen.findByText("Connected");
    wifiBridge.getConnectedNetwork.mockClear();

    fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));

    await waitFor(() =>
      expect(wifiBridge.disconnectFromNetwork).toHaveBeenCalledTimes(1),
    );
    await waitFor(() =>
      expect(wifiBridge.getConnectedNetwork).toHaveBeenCalled(),
    );
  });

  it("surfaces a rejected scan in the inline error banner", async () => {
    mockDefaults();
    wifiBridge.listAvailableNetworks.mockRejectedValue(
      new Error("location denied"),
    );

    renderView();

    expect(await screen.findByText("location denied")).toBeTruthy();
  });
});
