/**
 * Supplemental emulation, not physical proof: PendantSettingsCard renders the
 * production settings UI against injected hook states. The harness never claims
 * a real Bluetooth radio, phone, browser chooser, or physical pendant.
 */
// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { UsePendantResult } from "../../pendant/usePendant";
import { PendantSettingsCard } from "./PendantSettingsCard";

const usePendantMock = vi.hoisted(() => vi.fn<() => UsePendantResult>());

vi.mock("../../pendant/usePendant", () => ({
  usePendant: usePendantMock,
}));

const baseState: UsePendantResult["state"] = {
  status: "idle",
  connectStep: "idle",
  deviceName: null,
  batteryPercent: null,
  codecId: null,
  lastTranscript: null,
  droppedPackets: 0,
  error: null,
};

function renderWithPendant(overrides: Partial<UsePendantResult>) {
  usePendantMock.mockReturnValue({
    state: baseState,
    supported: true,
    connect: vi.fn(),
    disconnect: vi.fn(),
    ...overrides,
  });
  return render(<PendantSettingsCard />);
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("PendantSettingsCard supplemental emulation", () => {
  it("SUPPLEMENTAL EMULATION, NOT PHYSICAL PROOF: renders unsupported/Bluetooth unavailable UI", () => {
    renderWithPendant({
      supported: false,
      state: { ...baseState, status: "unsupported" },
    });

    expect(screen.getByTestId("pendant-settings")).toBeTruthy();
    expect(screen.getByTestId("pendant-status").textContent).toContain(
      "Not supported in this browser",
    );
    expect(
      screen.getByText("Bluetooth pendant not available here"),
    ).toBeTruthy();
    expect(screen.queryByTestId("pendant-connect")).toBeNull();
  });
});
