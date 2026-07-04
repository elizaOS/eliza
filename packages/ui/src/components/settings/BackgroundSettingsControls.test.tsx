// @vitest-environment jsdom
/**
 * Renders BackgroundSettingsControls against a seeded in-memory App store to
 * assert undo/redo affordances appear only when history exists and fire the
 * store callbacks. jsdom, no backend.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { __setAppValueForTests } from "../../state/app-store";
import { BackgroundSettingsControls } from "./BackgroundSettingsControls";

function seed(
  opts: {
    canUndoBackground?: boolean;
    canRedoBackground?: boolean;
    undoBackgroundConfig?: () => void;
    redoBackgroundConfig?: () => void;
  } = {},
) {
  __setAppValueForTests({
    backgroundConfig: { mode: "shader", color: "#ef5a1f" },
    setBackgroundConfig: vi.fn(),
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
