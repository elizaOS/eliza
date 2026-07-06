// @vitest-environment jsdom

/**
 * Render + dismiss contract for the home wallpaper long-press quick-picker
 * (#home-longpress): it portals a labelled dialog, embeds the SHARED background
 * controls (so it applies through the same store, not a fork), applies a choice
 * via the same setBackgroundConfig path, and closes on the scrim / close /
 * Escape. jsdom render with the app store seeded via `__setAppValueForTests`.
 */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { __setAppValueForTests } from "../../state/app-store";
import { HomeBackgroundQuickPicker } from "./HomeBackgroundQuickPicker";

function seed(opts: { setBackgroundConfig?: (config: unknown) => void } = {}) {
  __setAppValueForTests({
    t: (_key: string, o?: { defaultValue?: string }) => o?.defaultValue ?? _key,
    backgroundConfig: { mode: "shader", color: "#ef5a1f" },
    setBackgroundConfig: opts.setBackgroundConfig ?? vi.fn(),
    undoBackgroundConfig: vi.fn(),
    redoBackgroundConfig: vi.fn(),
    canUndoBackground: false,
    canRedoBackground: false,
    elizaCloudConnected: false,
    elizaCloudAuthRejected: false,
  } as never);
}

afterEach(() => {
  cleanup();
  __setAppValueForTests(null);
  vi.clearAllMocks();
});

describe("HomeBackgroundQuickPicker", () => {
  it("renders a labelled dialog embedding the shared background controls", () => {
    seed();
    render(<HomeBackgroundQuickPicker onClose={vi.fn()} />);
    const dialog = screen.getByRole("dialog");
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    // The SHARED controls are embedded — not a re-implemented picker.
    expect(screen.getByTestId("background-settings-controls")).toBeTruthy();
    expect(screen.getByTestId("background-catalog-gallery")).toBeTruthy();
  });

  it("applies a preset through the shared setBackgroundConfig path", () => {
    const setBackgroundConfig = vi.fn();
    seed({ setBackgroundConfig });
    render(<HomeBackgroundQuickPicker onClose={vi.fn()} />);
    // Any color swatch writes through the shared store.
    const swatch = screen.getByLabelText("Set background to Green");
    fireEvent.click(swatch);
    expect(setBackgroundConfig).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "shader" }),
    );
  });

  it("closes on the scrim, the close button, and Escape", () => {
    const onClose = vi.fn();
    seed();
    render(<HomeBackgroundQuickPicker onClose={onClose} />);

    fireEvent.click(screen.getByLabelText("Close background picker"));
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByLabelText("Close"));
    expect(onClose).toHaveBeenCalledTimes(2);

    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(3);
  });
});
