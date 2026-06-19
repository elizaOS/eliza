// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { handleReset } = vi.hoisted(() => ({ handleReset: vi.fn() }));

vi.mock("../../state", () => ({
  useApp: () => ({
    t: (key: string) => key,
    handleReset,
    exportBusy: false,
    exportPassword: "",
    exportIncludeLogs: false,
    exportError: null,
    exportSuccess: null,
    importBusy: false,
    importPassword: "",
    importFile: null,
    importError: null,
    importSuccess: null,
    handleAgentExport: vi.fn(),
    handleAgentImport: vi.fn(),
    setState: vi.fn(),
  }),
  useIsDeveloperMode: () => false,
  setDeveloperMode: vi.fn(),
}));

import { AdvancedSection } from "./AdvancedSection";

beforeEach(() => {
  handleReset.mockClear();
});

afterEach(() => cleanup());

function openResetModal() {
  fireEvent.click(
    screen.getByRole("button", { name: "settings.resetEverything" }),
  );
}

describe("AdvancedSection reset confirmation", () => {
  it("does not reset until the user confirms in the modal", () => {
    render(<AdvancedSection />);

    // Modal warning is not mounted before the danger-zone button is pressed.
    expect(screen.queryByText("settings.resetConfirmBody")).toBeNull();
    expect(handleReset).not.toHaveBeenCalled();
  });

  it("opens a warning modal when Reset Everything is pressed", () => {
    render(<AdvancedSection />);
    openResetModal();

    expect(screen.getByText("settings.resetConfirmTitle")).toBeTruthy();
    expect(screen.getByText("settings.resetConfirmBody")).toBeTruthy();
    // Opening the warning must never trigger the destructive action by itself.
    expect(handleReset).not.toHaveBeenCalled();
  });

  it("cancels without resetting", () => {
    render(<AdvancedSection />);
    openResetModal();

    fireEvent.click(screen.getByRole("button", { name: "common.cancel" }));

    expect(handleReset).not.toHaveBeenCalled();
    expect(screen.queryByText("settings.resetConfirmBody")).toBeNull();
  });

  it("runs the reset exactly once when confirmed", () => {
    render(<AdvancedSection />);
    openResetModal();

    fireEvent.click(
      screen.getByRole("button", { name: "settings.resetConfirmAction" }),
    );

    expect(handleReset).toHaveBeenCalledTimes(1);
  });
});
