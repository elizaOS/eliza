// @vitest-environment jsdom

import type {
  DeviceSettingsStatus,
  SystemStatus,
} from "@elizaos/capacitor-system";
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

const systemBridge = vi.hoisted(() => ({
  getDeviceSettings: vi.fn(),
  getStatus: vi.fn(),
  setScreenBrightness: vi.fn(),
  setVolume: vi.fn(),
  requestRole: vi.fn(),
  openSettings: vi.fn(),
  openWriteSettings: vi.fn(),
  openDisplaySettings: vi.fn(),
  openSoundSettings: vi.fn(),
  openNetworkSettings: vi.fn(),
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

import { DeviceSettingsAppView } from "./DeviceSettingsAppView";

const t = (_key: string, opts?: { defaultValue?: string }) =>
  opts?.defaultValue ?? "";

function overlayContext(exitToApps = vi.fn()) {
  return {
    exitToApps,
    uiTheme: "light" as const,
    t,
  };
}

// Realistic DeviceSettingsStatus mirroring a populated Android device:
// brightness 0.6 (60%), adaptive mode, write permission granted, and ALL SIX
// volume streams at distinct current/max so ordering, labels, percent readouts
// and the notification Bell icon are all exercised.
function fullDeviceSettings(): DeviceSettingsStatus {
  return {
    brightness: 0.6,
    brightnessMode: "automatic",
    canWriteSettings: true,
    volumes: [
      { stream: "music", current: 9, max: 15 }, // Media   -> 60%
      { stream: "ring", current: 5, max: 10 }, // Ring    -> 50%
      { stream: "alarm", current: 3, max: 10 }, // Alarm   -> 30%
      { stream: "notification", current: 7, max: 10 }, // Notifications -> 70%
      { stream: "system", current: 2, max: 8 }, // System  -> 25%
      { stream: "voiceCall", current: 4, max: 5 }, // Voice call -> 80%
    ],
  };
}

// SystemStatus with all four Android roles in distinct states:
// home held, dialer unavailable, sms not assigned, assistant assigned elsewhere.
function fullSystemStatus(): SystemStatus {
  return {
    packageName: "ai.eliza",
    roles: [
      {
        role: "home",
        androidRole: "android.app.role.HOME",
        held: true,
        holders: ["ai.eliza"],
        available: true,
      },
      {
        role: "dialer",
        androidRole: "android.app.role.DIALER",
        held: false,
        holders: [],
        available: false,
      },
      {
        role: "sms",
        androidRole: "android.app.role.SMS",
        held: false,
        holders: [],
        available: true,
      },
      {
        role: "assistant",
        androidRole: "android.app.role.ASSISTANT",
        held: false,
        holders: ["com.other.app"],
        available: true,
      },
    ],
  };
}

function mockBridgeFull() {
  systemBridge.getDeviceSettings.mockResolvedValue(fullDeviceSettings());
  systemBridge.getStatus.mockResolvedValue(fullSystemStatus());
}

// Hostile/clamping fixture preserved from the original suite.
function mockBridgeHostile() {
  systemBridge.getDeviceSettings.mockResolvedValue({
    brightness: Number.NaN,
    brightnessMode: "manual",
    canWriteSettings: true,
    volumes: [{ stream: "music", current: 999, max: 15 }],
  });
  systemBridge.getStatus.mockResolvedValue({
    packageName: "ai.eliza",
    roles: [
      {
        role: "sms",
        androidRole: "android.app.role.SMS",
        held: false,
        holders: [],
        available: true,
      },
    ],
  });
  systemBridge.setScreenBrightness.mockResolvedValue({
    brightness: 2,
    brightnessMode: "manual",
    canWriteSettings: true,
    volumes: [],
  });
  systemBridge.setVolume.mockResolvedValue({
    stream: "music",
    current: 20,
    max: 15,
  });
  systemBridge.requestRole.mockResolvedValue({
    role: "sms",
    held: true,
    resultCode: 0,
  });
}

function renderView(exitToApps = vi.fn()) {
  return render(
    React.createElement(DeviceSettingsAppView, overlayContext(exitToApps)),
  );
}

// Returns the card <div> wrapping a volume slider, for scoped label/icon asserts.
function volumeCard(stream: string): HTMLElement {
  return screen.getByTestId(`device-settings-volume-card-${stream}`);
}

// Returns the card <div> wrapping a role action button.
function roleCard(role: string): HTMLElement {
  return screen.getByTestId(`device-settings-role-card-${role}`);
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("DeviceSettingsAppView — populated data display", () => {
  it("renders header title and back/refresh controls", async () => {
    mockBridgeFull();
    renderView();

    expect(await screen.findByRole("heading", { name: "Device" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Back" })).toBeTruthy();
    expect(screen.getByTestId("device-settings-refresh")).toBeTruthy();
  });

  it("renders populated brightness data with adaptive mode and granted permission", async () => {
    mockBridgeFull();
    renderView();

    // Brightness percent readout reflects 0.6 -> 60%.
    const brightness = (await screen.findByTestId(
      "device-settings-brightness",
    )) as HTMLInputElement;
    expect(brightness.value).toBe("60");
    // "60%" also appears in the Media volume card (9/15) — scope the brightness
    // readout to its own section (the one holding the "Level" label).
    const brightnessSection = brightness.closest("section") as HTMLElement;
    expect(within(brightnessSection).getByText("60%")).toBeTruthy();
    expect(within(brightnessSection).getByText("Level")).toBeTruthy();

    // automatic -> "Adaptive".
    expect(screen.getByText("Adaptive")).toBeTruthy();
    expect(screen.queryByText("Manual")).toBeNull();

    // canWriteSettings true -> "Permission granted" and NO permission button.
    expect(screen.getByText("Permission granted")).toBeTruthy();
    expect(screen.queryByText("Permission needed")).toBeNull();
    expect(
      screen.queryByTestId("device-settings-open-write-settings"),
    ).toBeNull();
  });

  it("renders all six volume streams alphabetically with correct labels and percents", async () => {
    mockBridgeFull();
    renderView();

    // Stream count header.
    expect(await screen.findByText("6 streams")).toBeTruthy();

    // Cards are ordered alphabetically by display label.
    const labels = [
      "Alarm",
      "Media",
      "Notifications",
      "Ring",
      "System",
      "Voice call",
    ];
    const rendered = labels.map((l) => screen.getByText(l));
    const order = rendered.map((el) => el.compareDocumentPosition(rendered[0]));
    // Each later element should be positioned AFTER the first (Alarm).
    for (let i = 1; i < rendered.length; i++) {
      // DOCUMENT_POSITION_PRECEDING (2) means rendered[0] precedes rendered[i].
      expect(order[i] & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
    }

    // Per-stream live percent readouts (current/max -> %).
    expect(within(volumeCard("alarm")).getByText("30%")).toBeTruthy();
    expect(within(volumeCard("music")).getByText("60%")).toBeTruthy();
    expect(within(volumeCard("notification")).getByText("70%")).toBeTruthy();
    expect(within(volumeCard("ring")).getByText("50%")).toBeTruthy();
    expect(within(volumeCard("system")).getByText("25%")).toBeTruthy();
    expect(within(volumeCard("voiceCall")).getByText("80%")).toBeTruthy();

    // Per-stream slider value + max bounds.
    const ring = screen.getByTestId(
      "device-settings-volume-ring",
    ) as HTMLInputElement;
    expect(ring.value).toBe("5");
    expect(ring.max).toBe("10");
  });

  it("uses the Bell icon for the notification stream and Volume2 elsewhere", async () => {
    mockBridgeFull();
    renderView();
    await screen.findByText("6 streams");

    // lucide icons render as <svg class="lucide lucide-bell ...">.
    const notifCard = volumeCard("notification");
    expect(notifCard.querySelector("svg.lucide-bell")).toBeTruthy();
    expect(notifCard.querySelector("svg.lucide-volume2")).toBeNull();

    const mediaCard = volumeCard("music");
    expect(mediaCard.querySelector("svg.lucide-bell")).toBeNull();
    expect(mediaCard.querySelector("svg.lucide-volume2")).toBeTruthy();
  });

  it("renders role labels, status text, icons, and button states", async () => {
    mockBridgeFull();
    renderView();

    expect(await screen.findByText("4 roles")).toBeTruthy();

    // Home: held -> label "Home", status "Assigned", check icon, disabled "Assigned".
    // "Assigned" appears twice (status text + button label); scope the status
    // assertion to the status text div (the `.line-clamp-2` element).
    const home = roleCard("home");
    expect(within(home).getByText("Home")).toBeTruthy();
    const homeStatus = home.querySelector(".line-clamp-2");
    expect(homeStatus?.textContent).toBe("Assigned");
    expect(home.querySelector("svg.lucide-circle-check")).toBeTruthy();
    const homeBtn = screen.getByTestId(
      "device-settings-request-role-home",
    ) as HTMLButtonElement;
    expect(homeBtn.textContent).toBe("Assigned");
    expect(homeBtn.disabled).toBe(true);
    // Held role uses the check icon; the SlidersHorizontal fallback is absent.
    expect(home.querySelector("svg.lucide-sliders-horizontal")).toBeNull();

    // Phone (dialer): unavailable -> "Unavailable", disabled "Set role".
    const dialer = roleCard("dialer");
    expect(within(dialer).getByText("Phone")).toBeTruthy();
    expect(within(dialer).getByText("Unavailable")).toBeTruthy();
    const dialerBtn = screen.getByTestId(
      "device-settings-request-role-dialer",
    ) as HTMLButtonElement;
    expect(dialerBtn.textContent).toBe("Set role");
    expect(dialerBtn.disabled).toBe(true);

    // SMS: not assigned -> "Not assigned", enabled "Set role".
    const sms = roleCard("sms");
    expect(within(sms).getByText("SMS")).toBeTruthy();
    expect(within(sms).getByText("Not assigned")).toBeTruthy();
    const smsBtn = screen.getByTestId(
      "device-settings-request-role-sms",
    ) as HTMLButtonElement;
    expect(smsBtn.textContent).toBe("Set role");
    expect(smsBtn.disabled).toBe(false);

    // Assistant: assigned elsewhere -> holder name shown, enabled "Set role".
    const assistant = roleCard("assistant");
    expect(within(assistant).getByText("Assistant")).toBeTruthy();
    expect(within(assistant).getByText("com.other.app")).toBeTruthy();
    const assistantBtn = screen.getByTestId(
      "device-settings-request-role-assistant",
    ) as HTMLButtonElement;
    expect(assistantBtn.disabled).toBe(false);
  });
});

describe("DeviceSettingsAppView — interactions", () => {
  it("applies brightness, reports success notice, and reflects the returned value", async () => {
    mockBridgeFull();
    // Returned status moves brightness to 0.4 (40%) so we can prove the merge.
    systemBridge.setScreenBrightness.mockResolvedValue({
      brightness: 0.4,
      brightnessMode: "automatic",
      canWriteSettings: true,
      volumes: fullDeviceSettings().volumes,
    });
    renderView();

    const brightness = (await screen.findByTestId(
      "device-settings-brightness",
    )) as HTMLInputElement;
    fireEvent.change(brightness, { target: { value: "85" } });
    expect(brightness.value).toBe("85");

    fireEvent.click(screen.getByTestId("device-settings-apply-brightness"));

    await waitFor(() =>
      expect(systemBridge.setScreenBrightness).toHaveBeenCalledWith({
        brightness: 0.85,
      }),
    );

    // Success notice with role=status.
    const status = await screen.findByRole("status");
    expect(status.textContent).toContain("Brightness updated.");

    // Readout updates to the value the bridge returned (0.4 -> 40%).
    await waitFor(() =>
      expect(
        (screen.getByTestId("device-settings-brightness") as HTMLInputElement)
          .value,
      ).toBe("40"),
    );
  });

  it("applies a volume stream and merges the returned status into the card", async () => {
    mockBridgeFull();
    // Bridge returns ring at 8/10 (80%).
    systemBridge.setVolume.mockResolvedValue({
      stream: "ring",
      current: 8,
      max: 10,
    });
    renderView();

    const ring = (await screen.findByTestId(
      "device-settings-volume-ring",
    )) as HTMLInputElement;
    fireEvent.change(ring, { target: { value: "7" } });
    // Wait for the controlled edit to flush to the input before applying.
    // applyVolume reads the edited value from state; on a saturated runner the
    // change → re-render can lag the synchronous click, so without this the
    // handler can still see the loaded value (5) instead of 7.
    await waitFor(() => expect(ring.value).toBe("7"));

    fireEvent.click(screen.getByTestId("device-settings-apply-volume-ring"));

    await waitFor(() =>
      expect(systemBridge.setVolume).toHaveBeenCalledWith({
        stream: "ring",
        volume: 7,
      }),
    );

    const status = await screen.findByRole("status");
    expect(status.textContent).toContain("Ring volume updated.");

    // Card percent reflects the MERGED returned status (8/10 -> 80%), not the
    // slider's pre-apply value (7/10 -> 70%).
    await waitFor(() =>
      expect(within(volumeCard("ring")).getByText("80%")).toBeTruthy(),
    );
  });

  it("requests an Android role then refreshes status and flips the button", async () => {
    mockBridgeFull();
    systemBridge.requestRole.mockResolvedValue({
      role: "sms",
      held: true,
      resultCode: 0,
    });
    // After requestRole, getStatus is re-queried; return SMS now held.
    const afterStatus: SystemStatus = {
      packageName: "ai.eliza",
      roles: fullSystemStatus().roles.map((r) =>
        r.role === "sms"
          ? { ...r, held: true, holders: ["ai.eliza"], available: true }
          : r,
      ),
    };
    systemBridge.getStatus
      .mockResolvedValueOnce(fullSystemStatus()) // initial load
      .mockResolvedValueOnce(afterStatus); // refresh after requestRole

    renderView();

    const smsBtn = (await screen.findByTestId(
      "device-settings-request-role-sms",
    )) as HTMLButtonElement;
    expect(smsBtn.textContent).toBe("Set role");

    fireEvent.click(smsBtn);

    await waitFor(() =>
      expect(systemBridge.requestRole).toHaveBeenCalledWith({ role: "sms" }),
    );
    // getStatus called once on mount + once after requestRole.
    await waitFor(() =>
      expect(systemBridge.getStatus).toHaveBeenCalledTimes(2),
    );

    const status = await screen.findByRole("status");
    expect(status.textContent).toContain("SMS role updated.");

    // Button flips to disabled "Assigned".
    await waitFor(() => {
      const btn = screen.getByTestId(
        "device-settings-request-role-sms",
      ) as HTMLButtonElement;
      expect(btn.textContent).toBe("Assigned");
      expect(btn.disabled).toBe(true);
    });
  });

  it("opens each Android system settings panel with a success notice", async () => {
    mockBridgeFull();
    renderView();

    await screen.findByText("6 streams");

    fireEvent.click(screen.getByTestId("device-settings-open-system"));
    await waitFor(() =>
      expect(systemBridge.openSettings).toHaveBeenCalledTimes(1),
    );
    expect((await screen.findByRole("status")).textContent).toContain(
      "System settings opened.",
    );

    fireEvent.click(screen.getByTestId("device-settings-open-display"));
    await waitFor(() =>
      expect(systemBridge.openDisplaySettings).toHaveBeenCalledTimes(1),
    );
    expect((await screen.findByRole("status")).textContent).toContain(
      "Display settings opened.",
    );

    fireEvent.click(screen.getByTestId("device-settings-open-sound"));
    await waitFor(() =>
      expect(systemBridge.openSoundSettings).toHaveBeenCalledTimes(1),
    );
    expect((await screen.findByRole("status")).textContent).toContain(
      "Sound settings opened.",
    );

    fireEvent.click(screen.getByTestId("device-settings-open-network"));
    await waitFor(() =>
      expect(systemBridge.openNetworkSettings).toHaveBeenCalledTimes(1),
    );
    expect((await screen.findByRole("status")).textContent).toContain(
      "Network settings opened.",
    );
  });

  it("surfaces the write-settings permission button when permission is missing", async () => {
    systemBridge.getDeviceSettings.mockResolvedValue({
      ...fullDeviceSettings(),
      canWriteSettings: false,
    });
    systemBridge.getStatus.mockResolvedValue(fullSystemStatus());
    renderView();

    expect(await screen.findByText("Permission needed")).toBeTruthy();
    expect(screen.queryByText("Permission granted")).toBeNull();

    const permBtn = screen.getByTestId("device-settings-open-write-settings");
    fireEvent.click(permBtn);

    await waitFor(() =>
      expect(systemBridge.openWriteSettings).toHaveBeenCalledTimes(1),
    );
  });

  it("refreshes data on demand and updates the displayed values", async () => {
    // Initial load (fixtureA), then refresh returns a brighter device (fixtureB).
    systemBridge.getDeviceSettings
      .mockResolvedValueOnce(fullDeviceSettings()) // 0.6 -> 60%
      .mockResolvedValueOnce({
        ...fullDeviceSettings(),
        brightness: 0.2, // -> 20%
      });
    systemBridge.getStatus.mockResolvedValue(fullSystemStatus());
    renderView();

    expect(
      (
        (await screen.findByTestId(
          "device-settings-brightness",
        )) as HTMLInputElement
      ).value,
    ).toBe("60");

    fireEvent.click(screen.getByTestId("device-settings-refresh"));

    await waitFor(() =>
      expect(systemBridge.getDeviceSettings).toHaveBeenCalledTimes(2),
    );
    expect(systemBridge.getStatus).toHaveBeenCalledTimes(2);

    await waitFor(() =>
      expect(
        (screen.getByTestId("device-settings-brightness") as HTMLInputElement)
          .value,
      ).toBe("20"),
    );
  });

  it("shows empty-states when the runtime exposes no streams or roles", async () => {
    systemBridge.getDeviceSettings.mockResolvedValue({
      brightness: 0.5,
      brightnessMode: "manual",
      canWriteSettings: false,
      volumes: [],
    });
    systemBridge.getStatus.mockResolvedValue({
      packageName: "web",
      roles: [],
    });
    renderView();

    expect(await screen.findAllByText("Unavailable")).toHaveLength(2);
    expect(screen.getByText("0 streams")).toBeTruthy();
    expect(screen.getByText("0 roles")).toBeTruthy();
  });

  it("clears a prior error when a follow-up action succeeds", async () => {
    mockBridgeFull();
    systemBridge.openNetworkSettings.mockRejectedValueOnce(
      new Error("network settings unavailable"),
    );
    renderView();

    await screen.findByText("6 streams");

    // First action fails -> role=alert.
    fireEvent.click(screen.getByTestId("device-settings-open-network"));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("network settings unavailable");

    // Second, succeeding action clears the error and shows role=status notice.
    fireEvent.click(screen.getByTestId("device-settings-open-system"));
    await waitFor(() =>
      expect(systemBridge.openSettings).toHaveBeenCalledTimes(1),
    );
    const status = await screen.findByRole("status");
    expect(status.textContent).toContain("System settings opened.");
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("DeviceSettingsAppView — hostile/back-out edge cases", () => {
  it("clamps hostile bridge brightness and volume values before writing them back", async () => {
    mockBridgeHostile();

    renderView();

    const brightness = await screen.findByTestId("device-settings-brightness");
    expect((brightness as HTMLInputElement).value).toBe("0");

    const musicVolume = await screen.findByTestId(
      "device-settings-volume-music",
    );
    expect((musicVolume as HTMLInputElement).value).toBe("15");

    fireEvent.change(musicVolume, { target: { value: "999" } });
    fireEvent.click(screen.getByTestId("device-settings-apply-volume-music"));

    await waitFor(() =>
      expect(systemBridge.setVolume).toHaveBeenCalledWith({
        stream: "music",
        volume: 15,
      }),
    );

    fireEvent.click(screen.getByTestId("device-settings-apply-brightness"));
    await waitFor(() =>
      expect(systemBridge.setScreenBrightness).toHaveBeenCalledWith({
        brightness: 0,
      }),
    );
  });

  it("backs out through overlay context and reports system panel failures", async () => {
    mockBridgeHostile();
    systemBridge.openNetworkSettings.mockRejectedValue(
      new Error("network settings unavailable"),
    );
    const exitToApps = vi.fn();

    renderView(exitToApps);

    fireEvent.click(await screen.findByRole("button", { name: "Back" }));
    expect(exitToApps).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTestId("device-settings-open-network"));

    expect((await screen.findByRole("alert")).textContent).toContain(
      "network settings unavailable",
    );
  });
});
