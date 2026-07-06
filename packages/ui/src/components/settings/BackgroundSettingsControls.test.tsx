// @vitest-environment jsdom
/**
 * Renders the BackgroundSettingsControls wallpaper gallery against a seeded
 * in-memory App store: asserts the gallery renders live tiles, marks the active
 * wallpaper, applies a choice on tap through the shared store, and that the
 * revert (undo/redo) affordances appear only when history exists and fire the
 * store callbacks. jsdom, no backend.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { __setAppValueForTests } from "../../state/app-store";
import type { BackgroundConfig } from "../../state/ui-preferences";
import { BackgroundSettingsControls } from "./BackgroundSettingsControls";

function seed(
  opts: {
    canUndoBackground?: boolean;
    canRedoBackground?: boolean;
    undoBackgroundConfig?: () => void;
    redoBackgroundConfig?: () => void;
    setBackgroundConfig?: (config: BackgroundConfig) => void;
    backgroundConfig?: BackgroundConfig;
  } = {},
) {
  __setAppValueForTests({
    backgroundConfig: opts.backgroundConfig ?? {
      mode: "shader",
      color: "#ef5a1f",
    },
    setBackgroundConfig: opts.setBackgroundConfig ?? vi.fn(),
    undoBackgroundConfig: opts.undoBackgroundConfig ?? vi.fn(),
    redoBackgroundConfig: opts.redoBackgroundConfig ?? vi.fn(),
    canUndoBackground: opts.canUndoBackground ?? false,
    canRedoBackground: opts.canRedoBackground ?? false,
    elizaCloudConnected: false,
    elizaCloudAuthRejected: false,
    setState: vi.fn(),
  } as never);
}

afterEach(() => {
  cleanup();
  __setAppValueForTests(null);
  vi.clearAllMocks();
});

describe("BackgroundSettingsControls undo/redo", () => {
  it("hides the undo/redo pair when there is no history in either direction", () => {
    seed();

    render(<BackgroundSettingsControls />);

    expect(screen.queryByLabelText("Undo background change")).toBeNull();
    expect(screen.queryByLabelText("Redo background change")).toBeNull();
  });

  it("renders Redo disabled when there is undo history but nothing undone", () => {
    seed({ canUndoBackground: true, canRedoBackground: false });

    render(<BackgroundSettingsControls />);

    const undo = screen.getByLabelText(
      "Undo background change",
    ) as HTMLButtonElement;
    const redo = screen.getByLabelText(
      "Redo background change",
    ) as HTMLButtonElement;
    expect(undo.disabled).toBe(false);
    expect(redo.disabled).toBe(true);
  });

  it("calls redoBackgroundConfig when redo history exists", () => {
    const redoBackgroundConfig = vi.fn();
    seed({
      canUndoBackground: false,
      canRedoBackground: true,
      redoBackgroundConfig,
    });

    render(<BackgroundSettingsControls />);

    const undo = screen.getByLabelText(
      "Undo background change",
    ) as HTMLButtonElement;
    const redo = screen.getByLabelText(
      "Redo background change",
    ) as HTMLButtonElement;
    expect(undo.disabled).toBe(true);
    expect(redo.disabled).toBe(false);
    fireEvent.click(redo);
    expect(redoBackgroundConfig).toHaveBeenCalledTimes(1);
  });

  it("calls undoBackgroundConfig from the paired Undo control", () => {
    const undoBackgroundConfig = vi.fn();
    seed({
      canUndoBackground: true,
      canRedoBackground: true,
      undoBackgroundConfig,
    });

    render(<BackgroundSettingsControls />);

    fireEvent.click(screen.getByLabelText("Undo background change"));
    expect(undoBackgroundConfig).toHaveBeenCalledTimes(1);
  });
});

describe("BackgroundSettingsControls wallpaper gallery", () => {
  it("renders the gallery with live wallpaper tiles", () => {
    seed();
    render(<BackgroundSettingsControls />);

    const gallery = screen.getByTestId("background-catalog-gallery");
    expect(gallery).toBeTruthy();
    // Curated catalog tiles and color presets both render as tappable tiles.
    expect(
      screen.getByLabelText("Set background to Misty Forest"),
    ).toBeTruthy();
    expect(screen.getByLabelText("Set background to Green")).toBeTruthy();
  });

  it("marks the active wallpaper as pressed and leaves others unpressed", () => {
    // The live config is the Green shader color, so its tile is the active one.
    seed({ backgroundConfig: { mode: "shader", color: "#059669" } });
    render(<BackgroundSettingsControls />);

    const green = screen.getByLabelText("Set background to Green");
    const rose = screen.getByLabelText("Set background to Rose");
    expect(green.getAttribute("aria-pressed")).toBe("true");
    expect(rose.getAttribute("aria-pressed")).toBe("false");
  });

  it("applies a wallpaper on tap through the shared store", () => {
    const setBackgroundConfig = vi.fn();
    seed({ setBackgroundConfig });
    render(<BackgroundSettingsControls />);

    fireEvent.click(screen.getByLabelText("Set background to Rose"));
    expect(setBackgroundConfig).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "shader", color: "#e11d48" }),
    );
  });

  it("lays the filmstrip variant out as a single scroll row of tiles", () => {
    seed();
    render(<BackgroundSettingsControls variant="filmstrip" />);

    const root = screen.getByTestId("background-settings-controls");
    expect(root.getAttribute("data-variant")).toBe("filmstrip");
    // Tiles still apply on tap in the condensed sheet.
    expect(
      screen.getByLabelText("Set background to Misty Forest"),
    ).toBeTruthy();
  });
});
