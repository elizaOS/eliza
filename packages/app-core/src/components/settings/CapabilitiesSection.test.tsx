/* @vitest-environment jsdom */

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CapabilitiesSection } from "./CapabilitiesSection";

const useAppMock = vi.fn();

vi.mock("../../state", () => ({
  useApp: () => useAppMock(),
}));

describe("CapabilitiesSection", () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    useAppMock.mockReset();
  });

  it("renders the computer use capability and its config hint when enabled", () => {
    useAppMock.mockReturnValue({
      walletEnabled: false,
      browserEnabled: false,
      computerUseEnabled: true,
      setState: vi.fn(),
      t: (_key: string, values?: Record<string, unknown>) =>
        typeof values?.defaultValue === "string" ? values.defaultValue : _key,
    });

    render(<CapabilitiesSection />);

    expect(screen.getByText("Enable Computer Use")).toBeTruthy();
    expect(
      screen.getByText(/Accessibility and Screen Recording permissions/i),
    ).toBeTruthy();
  });

  it("hides the computer use config hint when disabled", () => {
    useAppMock.mockReturnValue({
      walletEnabled: false,
      browserEnabled: false,
      computerUseEnabled: false,
      setState: vi.fn(),
      t: (_key: string, values?: Record<string, unknown>) =>
        typeof values?.defaultValue === "string" ? values.defaultValue : _key,
    });

    render(<CapabilitiesSection />);

    expect(screen.getAllByText("Enable Computer Use")).toHaveLength(1);
    expect(
      screen.queryByText(/Accessibility and Screen Recording permissions/i),
    ).toBeNull();
  });
});
