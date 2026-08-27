/** Verifies BackgroundSettingsControls undo/redo through the package's configured test harness. */
// @vitest-environment jsdom
/**
 * Renders the BackgroundSettingsControls wallpaper gallery against a seeded
 * in-memory App store: asserts the gallery renders live tiles, marks the active
 * wallpaper, applies a choice on tap through the shared store, and that the
 * revert (undo/redo) affordances appear only when history exists and fire the
 * store callbacks. jsdom, no backend.
 */
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
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
    // Curated image tiles render as tappable tiles; the color/shader presets
    // are gone from the MVP picker (images + upload only).
    expect(
      screen.getByLabelText("Set background to Misty Forest"),
    ).toBeTruthy();
    expect(screen.queryByLabelText("Set background to Green")).toBeNull();
    expect(
      screen.queryByLabelText("Pick a custom background color"),
    ).toBeNull();
    expect(screen.queryByLabelText("Generate a background image")).toBeNull();
  });

  it("marks the active wallpaper as pressed and leaves others unpressed", () => {
    // The live config is the Reef image, so its tile is the active one.
    seed({
      backgroundConfig: {
        mode: "image",
        color: "#ef5a1f",
        imageUrl: "/wallpapers/reef.webp",
      },
    });
    render(<BackgroundSettingsControls />);

    const reef = screen.getByLabelText("Set background to Reef");
    const misty = screen.getByLabelText("Set background to Misty Forest");
    expect(reef.getAttribute("aria-pressed")).toBe("true");
    expect(misty.getAttribute("aria-pressed")).toBe("false");
  });

  it("applies a wallpaper on tap through the shared store", () => {
    const setBackgroundConfig = vi.fn();
    seed({ setBackgroundConfig });
    render(<BackgroundSettingsControls />);

    fireEvent.click(screen.getByLabelText("Set background to Reef"));
    expect(setBackgroundConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "image",
        imageUrl: "/wallpapers/reef.webp",
      }),
    );
  });

  it("brings the active wallpaper into view when the filmstrip opens", () => {
    const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView,
    });

    try {
      seed({
        backgroundConfig: {
          mode: "image",
          color: "#ef5a1f",
          imageUrl: "/bg-sunset.webp",
        },
      });
      render(<BackgroundSettingsControls variant="filmstrip" />);

      expect(
        screen
          .getByLabelText("Set background to Ember Night")
          .getAttribute("aria-pressed"),
      ).toBe("true");
      expect(scrollIntoView).toHaveBeenCalledWith({
        behavior: "auto",
        block: "nearest",
        inline: "center",
      });
    } finally {
      if (originalScrollIntoView) {
        Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
          configurable: true,
          value: originalScrollIntoView,
        });
      } else {
        Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
      }
    }
  });

  it("keeps full wallpaper names legible in one labelled filmstrip", () => {
    const setBackgroundConfig = vi.fn();
    seed({ setBackgroundConfig });
    render(<BackgroundSettingsControls variant="filmstrip" />);

    const root = screen.getByTestId("background-settings-controls");
    expect(root.getAttribute("data-variant")).toBe("filmstrip");
    const choices = screen.getByRole("group", { name: "Wallpaper choices" });
    expect(within(choices).getByText("Misty Forest")).toBeTruthy();
    expect(within(choices).getByText("Desert Dusk")).toBeTruthy();
    expect(within(choices).getByText("Ocean Deep")).toBeTruthy();

    // The compact visual treatment still writes through the canonical store.
    fireEvent.click(
      within(choices).getByLabelText("Set background to Ocean Deep"),
    );
    expect(setBackgroundConfig).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "image" }),
    );
  });

  it("keeps upload available as the filmstrip's secondary action", () => {
    seed();
    const { container } = render(
      <BackgroundSettingsControls variant="filmstrip" />,
    );
    const input =
      container.querySelector<HTMLInputElement>('input[type="file"]');
    expect(input).not.toBeNull();
    const clickFileInput = vi.spyOn(input as HTMLInputElement, "click");

    fireEvent.click(screen.getByLabelText("Upload a background image"));

    expect(clickFileInput).toHaveBeenCalledTimes(1);
  });
});
