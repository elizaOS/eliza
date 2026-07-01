// @vitest-environment jsdom
/**
 * Real-store behavioral coverage for the /background controls.
 *
 * The sibling BackgroundView.test.tsx / BackgroundSettingsSection.test.tsx seed
 * the app store with vi.fn() handlers and assert on the mock. This suite instead
 * drives the REAL persisted display-preferences store (useDisplayPreferences)
 * through the live BackgroundSettingsControls component and asserts the full
 * round-trip: click -> store mutation -> localStorage -> re-render -> DOM. Only
 * the generate-image API (a network collaborator) is mocked.
 */
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { useLayoutEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { client } from "../../api";
import { __setAppValueForTests } from "../../state/app-store";
import {
  loadBackgroundConfig,
  loadBackgroundHistory,
} from "../../state/persistence";
import { DEFAULT_BACKGROUND_COLOR } from "../../state/ui-preferences";
import { useDisplayPreferences } from "../../state/useDisplayPreferences";
import { BackgroundSettingsControls } from "./BackgroundSettingsControls";

vi.mock("../pages/background-image", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../pages/background-image")>();
  return {
    ...actual,
    fileToBackgroundDataUrl: vi.fn(async () => "data:image/png;base64,IMGBYTES"),
  };
});

const GREEN = "#059669";
const ROSE = "#e11d48";

/**
 * Bridges the REAL useDisplayPreferences store into the app-store snapshot the
 * component reads, re-publishing on every render so a store mutation flows back
 * out to the DOM exactly as it does in production (BackgroundHost wires the same
 * hook into AppContext).
 */
function RealStoreHarness({ cloud = false }: { cloud?: boolean }) {
  const dp = useDisplayPreferences();
  useLayoutEffect(() => {
    __setAppValueForTests({
      backgroundConfig: dp.state.backgroundConfig,
      setBackgroundConfig: dp.setBackgroundConfig,
      undoBackgroundConfig: dp.undoBackgroundConfig,
      canUndoBackground: dp.state.canUndoBackground,
      elizaCloudConnected: cloud,
      elizaCloudAuthRejected: false,
    } as never);
  });
  return <BackgroundSettingsControls />;
}

function pressed(label: string): string | null {
  return screen.getByLabelText(label).getAttribute("aria-pressed");
}

beforeEach(() => {
  localStorage.clear();
});
afterEach(() => {
  cleanup();
  __setAppValueForTests(null);
  localStorage.clear();
  vi.clearAllMocks();
});

describe("BackgroundSettingsControls — real display-preferences store", () => {
  it("picking a preset mutates the persisted store and round-trips to the DOM", async () => {
    render(<RealStoreHarness />);

    // Default: no undo, no swatch pressed except the default orange.
    expect(screen.queryByLabelText("Undo background change")).toBeNull();

    fireEvent.click(screen.getByLabelText("Set background to Green"));

    // Store + persistence mutated.
    await waitFor(() =>
      expect(loadBackgroundConfig()).toEqual({ mode: "shader", color: GREEN }),
    );
    expect(loadBackgroundHistory().length).toBe(1);

    // DOM reflects the new selection without any re-seed by the test.
    await waitFor(() => expect(pressed("Set background to Green")).toBe("true"));
    expect(pressed("Set background to Orange")).toBe("false");
    // History now exists -> the Undo control appears.
    expect(screen.getByLabelText("Undo background change")).not.toBeNull();
  });

  it("the custom color input writes an arbitrary shader color and presses no preset", async () => {
    render(<RealStoreHarness />);
    const colorInput = screen.getByLabelText(
      "Custom background color value",
    ) as HTMLInputElement;

    fireEvent.change(colorInput, { target: { value: "#123456" } });

    await waitFor(() =>
      expect(loadBackgroundConfig()).toEqual({
        mode: "shader",
        color: "#123456",
      }),
    );
    // Not a preset -> none of the swatches is pressed.
    expect(pressed("Set background to Green")).toBe("false");
    expect(pressed("Set background to Orange")).toBe("false");
  });

  it("uploading an image switches shader->image mode, preserving the color, then back", async () => {
    render(<RealStoreHarness />);

    fireEvent.click(screen.getByLabelText("Set background to Green"));
    await waitFor(() => expect(pressed("Set background to Green")).toBe("true"));

    const fileInput =
      document.querySelector<HTMLInputElement>('input[type="file"]');
    expect(fileInput).not.toBeNull();
    fireEvent.change(fileInput as HTMLInputElement, {
      target: { files: [new File(["x"], "bg.png", { type: "image/png" })] },
    });

    // Now in image mode: color preserved, imageUrl set, no swatch pressed.
    await waitFor(() =>
      expect(loadBackgroundConfig()).toEqual({
        mode: "image",
        color: GREEN,
        imageUrl: "data:image/png;base64,IMGBYTES",
      }),
    );
    expect(pressed("Set background to Green")).toBe("false");

    // Selecting a swatch flips back to shader mode.
    fireEvent.click(screen.getByLabelText("Set background to Rose"));
    await waitFor(() =>
      expect(loadBackgroundConfig()).toEqual({ mode: "shader", color: ROSE }),
    );
    expect(pressed("Set background to Rose")).toBe("true");
  });

  it("rapid identical applies are idempotent — one history entry, single active color", async () => {
    render(<RealStoreHarness />);
    const green = screen.getByLabelText("Set background to Green");

    // Six successive clicks, each a distinct flushed event (as the browser
    // delivers them). Only the first is a real transition; the rest are no-ops.
    for (let i = 0; i < 6; i++) fireEvent.click(green);

    await waitFor(() => expect(pressed("Set background to Green")).toBe("true"));
    // Setting the same config is a no-op: only the first transition recorded.
    expect(loadBackgroundConfig().color).toBe(GREEN);
    expect(loadBackgroundHistory().length).toBe(1);

    // A single undo returns all the way to the default (nothing to churn).
    fireEvent.click(screen.getByLabelText("Undo background change"));
    await waitFor(() =>
      expect(loadBackgroundConfig().color).toBe(DEFAULT_BACKGROUND_COLOR),
    );
    expect(screen.queryByLabelText("Undo background change")).toBeNull();
  });

  it("undo steps back through real history and resets to the default", async () => {
    render(<RealStoreHarness />);

    fireEvent.click(screen.getByLabelText("Set background to Green"));
    await waitFor(() => expect(loadBackgroundConfig().color).toBe(GREEN));
    fireEvent.click(screen.getByLabelText("Set background to Rose"));
    await waitFor(() => expect(loadBackgroundConfig().color).toBe(ROSE));

    fireEvent.click(screen.getByLabelText("Undo background change"));
    await waitFor(() => expect(loadBackgroundConfig().color).toBe(GREEN));
    await waitFor(() => expect(pressed("Set background to Green")).toBe("true"));

    fireEvent.click(screen.getByLabelText("Undo background change"));
    await waitFor(() =>
      expect(loadBackgroundConfig().color).toBe(DEFAULT_BACKGROUND_COLOR),
    );
    // Back at the origin: undo control gone, default swatch pressed.
    expect(screen.queryByLabelText("Undo background change")).toBeNull();
    expect(pressed("Set background to Orange")).toBe("true");
  });

  it("generate applies the returned media URL to the real store (image mode)", async () => {
    const spy = vi
      .spyOn(client, "generateBackgroundImage")
      .mockResolvedValue({ url: "/api/media/abc123.png" });
    render(<RealStoreHarness cloud />);

    fireEvent.click(screen.getByLabelText("Generate a background image"));
    fireEvent.change(screen.getByPlaceholderText("Describe a background..."), {
      target: { value: "  a calm neon coastline  " },
    });
    fireEvent.click(screen.getByLabelText("Generate background from prompt"));

    // Exact trimmed prompt forwarded to the mocked collaborator.
    await waitFor(() =>
      expect(spy).toHaveBeenCalledWith("a calm neon coastline"),
    );
    await waitFor(() =>
      expect(loadBackgroundConfig()).toEqual({
        mode: "image",
        color: DEFAULT_BACKGROUND_COLOR,
        imageUrl: "/api/media/abc123.png",
      }),
    );
    // Image mode -> no shader swatch pressed; the prompt form closed on success.
    expect(pressed("Set background to Orange")).toBe("false");
    expect(screen.queryByPlaceholderText("Describe a background...")).toBeNull();
  });

  it("generate failure surfaces an alert and leaves the real store untouched", async () => {
    const spy = vi
      .spyOn(client, "generateBackgroundImage")
      .mockRejectedValue(new Error("out of credits"));
    render(<RealStoreHarness cloud />);

    fireEvent.click(screen.getByLabelText("Generate a background image"));
    fireEvent.change(screen.getByPlaceholderText("Describe a background..."), {
      target: { value: "anything" },
    });
    fireEvent.click(screen.getByLabelText("Generate background from prompt"));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("out of credits");
    expect(spy).toHaveBeenCalledTimes(1);
    // No mutation: still the untouched default, nothing pushed to history.
    expect(loadBackgroundConfig()).toEqual({
      mode: "shader",
      color: DEFAULT_BACKGROUND_COLOR,
    });
    expect(loadBackgroundHistory().length).toBe(0);
  });

  it("a whitespace-only prompt keeps submit disabled and never calls the API", () => {
    const spy = vi.spyOn(client, "generateBackgroundImage");
    render(<RealStoreHarness cloud />);

    fireEvent.click(screen.getByLabelText("Generate a background image"));
    fireEvent.change(screen.getByPlaceholderText("Describe a background..."), {
      target: { value: "   " },
    });

    const submit = screen.getByLabelText(
      "Generate background from prompt",
    ) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.click(submit);
    expect(spy).not.toHaveBeenCalled();
  });
});
