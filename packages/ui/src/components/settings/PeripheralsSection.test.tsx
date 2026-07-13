// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const bootConfig = vi.hoisted(() => ({
  phonePairingSettingsCard: undefined as
    | React.ComponentType<Record<string, never>>
    | undefined,
}));

vi.mock("../../config/boot-config-react.hooks", () => ({
  useBootConfig: () => bootConfig,
}));

vi.mock("./PendantSettingsCard", () => ({
  PendantSettingsCard: () => <div data-testid="pendant-settings" />,
}));

import { PeripheralsSection } from "./PeripheralsSection";

afterEach(() => {
  cleanup();
  bootConfig.phonePairingSettingsCard = undefined;
});

describe("PeripheralsSection", () => {
  it("owns pendant setup and a concise phone fallback", () => {
    render(<PeripheralsSection />);

    expect(screen.getByTestId("pendant-settings")).toBeTruthy();
    expect(screen.getByText("Unavailable in this build")).toBeTruthy();
  });

  it("renders the host-provided native phone pairing card", () => {
    bootConfig.phonePairingSettingsCard = () => (
      <div data-testid="native-phone-pairing" />
    );

    render(<PeripheralsSection />);

    expect(screen.getByTestId("native-phone-pairing")).toBeTruthy();
    expect(screen.queryByText("Unavailable in this build")).toBeNull();
  });
});
