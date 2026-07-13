// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const platform = vi.hoisted(() => ({ native: true, name: "ios" }));
const intent = vi.hoisted(() => ({
  getPairingStatus: vi.fn(),
  setPairingStatus: vi.fn(async () => ({ ok: true })),
}));

vi.mock("@capacitor/core", async () => {
  const actual =
    await vi.importActual<typeof import("@capacitor/core")>("@capacitor/core");
  return {
    ...actual,
    Capacitor: {
      ...actual.Capacitor,
      isNativePlatform: () => platform.native,
      getPlatform: () => platform.name,
    },
  };
});

vi.mock("../services", async () => {
  const actual =
    await vi.importActual<typeof import("../services")>("../services");
  return {
    ...actual,
    ElizaIntent: intent,
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
});

import { PhonePairingSettingsCard } from "./PhonePairingSettingsCard";

function encodePayload(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64");
}

beforeEach(() => {
  platform.native = true;
  platform.name = "ios";
  intent.getPairingStatus.mockResolvedValue({
    paired: false,
    agentUrl: null,
    deviceId: null,
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("PhonePairingSettingsCard", () => {
  it("shows one concise unavailable row outside native iOS", () => {
    platform.native = false;
    platform.name = "web";

    render(<PhonePairingSettingsCard />);

    expect(screen.getByText("iOS app only")).toBeTruthy();
    expect(screen.queryByTestId("phone-pairing-controls")).toBeNull();
    expect(intent.getPairingStatus).not.toHaveBeenCalled();
  });

  it("does not expose the iOS pairing bridge on native Android", () => {
    platform.native = true;
    platform.name = "android";

    render(<PhonePairingSettingsCard />);

    expect(screen.getByText("iOS app only")).toBeTruthy();
    expect(screen.queryByTestId("phone-pairing-controls")).toBeNull();
    expect(intent.getPairingStatus).not.toHaveBeenCalled();
  });

  it("reads native status and pairs from the compact form", async () => {
    const payload = {
      agentId: "agent-1",
      pairingCode: "code-1",
      ingressUrl: "wss://relay.example/input",
      sessionToken: "token-1",
    };
    render(<PhonePairingSettingsCard />);

    await screen.findByText("Not paired");
    fireEvent.change(screen.getByLabelText("Pairing code"), {
      target: { value: encodePayload(payload) },
    });
    fireEvent.click(screen.getByRole("button", { name: "Pair" }));

    await waitFor(() => {
      expect(intent.setPairingStatus).toHaveBeenCalledWith({
        deviceId: payload.agentId,
        agentUrl: payload.ingressUrl,
      });
      expect(screen.getByText("Paired with agent-1")).toBeTruthy();
    });
  });
});
