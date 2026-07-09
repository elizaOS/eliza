// @vitest-environment jsdom
//
// Renders the real BackgroundView to cover wallpaper selection (image config),
// undo/redo visibility + revert against the persisted history, and upload.
// The MVP picker is images + upload only — no swatches, no AI generation.
// jsdom; only background-image (canvas downscale) is stubbed.
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { client } from "../../api";
import { __setAppValueForTests } from "../../state/app-store";

vi.mock("./background-image", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./background-image")>();
  return {
    ...actual,
    fileToBackgroundDataUrl: vi.fn(async () => "data:image/jpeg;base64,ZZZ"),
  };
});

import { BackgroundView } from "./BackgroundView";

function seed(
  opts: {
    cloud?: boolean;
    setBackgroundConfig?: (config: unknown) => void;
    undoBackgroundConfig?: () => void;
    redoBackgroundConfig?: () => void;
    canUndo?: boolean;
    canRedo?: boolean;
    color?: string;
  } = {},
) {
  __setAppValueForTests({
    backgroundConfig: { mode: "shader", color: opts.color ?? "#ef5a1f" },
    setBackgroundConfig: opts.setBackgroundConfig ?? vi.fn(),
    undoBackgroundConfig: opts.undoBackgroundConfig ?? vi.fn(),
    redoBackgroundConfig: opts.redoBackgroundConfig ?? vi.fn(),
    canUndoBackground: opts.canUndo ?? false,
    canRedoBackground: opts.canRedo ?? false,
    elizaCloudConnected: opts.cloud ?? false,
    elizaCloudAuthRejected: false,
  } as never);
}

afterEach(() => {
  cleanup();
  __setAppValueForTests(null);
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("BackgroundView", () => {
  it("selecting a wallpaper tile sets an image config", () => {
    const setBackgroundConfig = vi.fn();
    seed({ setBackgroundConfig });
    render(<BackgroundView />);
    fireEvent.click(screen.getByLabelText("Set background to Reef"));
    expect(setBackgroundConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "image",
        imageUrl: "/wallpapers/reef.webp",
      }),
    );
  });

  it("hides Undo when there is no history", () => {
    seed({ canUndo: false });
    render(<BackgroundView />);
    expect(screen.queryByLabelText("Undo background change")).toBeNull();
  });

  it("shows Undo and reverts the background when history exists", () => {
    const undoBackgroundConfig = vi.fn();
    seed({ canUndo: true, undoBackgroundConfig });
    render(<BackgroundView />);
    fireEvent.click(screen.getByLabelText("Undo background change"));
    expect(undoBackgroundConfig).toHaveBeenCalledTimes(1);
  });

  it("shows Redo and re-applies the undone background", () => {
    const redoBackgroundConfig = vi.fn();
    seed({ canUndo: false, canRedo: true, redoBackgroundConfig });
    render(<BackgroundView />);
    fireEvent.click(screen.getByLabelText("Redo background change"));
    expect(redoBackgroundConfig).toHaveBeenCalledTimes(1);
  });

  it("never offers AI generation, even with cloud connected (MVP picker)", () => {
    seed({ cloud: true });
    render(<BackgroundView />);
    expect(screen.queryByLabelText("Generate a background image")).toBeNull();
  });

  it("uploading an image sets an image config", async () => {
    const setBackgroundConfig = vi.fn();
    const uploadBackgroundImage = vi
      .spyOn(client, "uploadBackgroundImage")
      .mockResolvedValue({ url: "/api/media/test-background" });
    seed({ setBackgroundConfig });
    render(<BackgroundView />);
    const input =
      document.querySelector<HTMLInputElement>('input[type="file"]');
    expect(input).not.toBeNull();
    const file = new File(["x"], "x.png", { type: "image/png" });
    fireEvent.change(input as HTMLInputElement, { target: { files: [file] } });
    await waitFor(() =>
      expect(uploadBackgroundImage).toHaveBeenCalledWith(
        "data:image/jpeg;base64,ZZZ",
      ),
    );
    await waitFor(() =>
      expect(setBackgroundConfig).toHaveBeenCalledWith({
        mode: "image",
        color: "#ef5a1f",
        imageUrl: "/api/media/test-background",
      }),
    );
  });
});
