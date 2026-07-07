// @vitest-environment jsdom
/**
 * Renders BackgroundSettingsSection against a seeded in-memory App store and
 * asserts it mounts the unified background controls and forwards a wallpaper pick
 * to `setBackgroundConfig`. jsdom; the background-image module is mocked.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { __setAppValueForTests } from "../../state/app-store";
import { BackgroundSettingsSection } from "./BackgroundSettingsSection";

vi.mock("../pages/background-image", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../pages/background-image")>();
  return {
    ...actual,
    fileToBackgroundDataUrl: vi.fn(async () => "data:image/jpeg;base64,ZZZ"),
  };
});

function seed(opts: { setBackgroundConfig?: (config: unknown) => void } = {}) {
  __setAppValueForTests({
    t: (_key: string, opts?: { defaultValue?: string }) =>
      opts?.defaultValue ?? _key,
    backgroundConfig: { mode: "shader", color: "#ef5a1f" },
    setBackgroundConfig: opts.setBackgroundConfig ?? vi.fn(),
    undoBackgroundConfig: vi.fn(),
    redoBackgroundConfig: vi.fn(),
    canUndoBackground: false,
    canRedoBackground: false,
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

describe("BackgroundSettingsSection", () => {
  it("renders the unified background controls as a standalone subview", () => {
    const setBackgroundConfig = vi.fn();
    seed({ setBackgroundConfig });

    render(<BackgroundSettingsSection />);

    expect(screen.getByTestId("background-settings-controls")).not.toBeNull();
    fireEvent.click(screen.getByLabelText("Set background to Reef"));
    expect(setBackgroundConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "image",
        imageUrl: "/wallpapers/reef.webp",
      }),
    );
  });
});
