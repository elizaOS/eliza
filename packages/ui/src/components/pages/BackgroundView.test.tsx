// @vitest-environment jsdom
//
// Renders the real BackgroundView to cover swatch selection (shader config),
// undo/redo visibility + revert against the persisted history, and gating the
// cloud "Generate" control on cloud availability. jsdom; only background-image
// (canvas downscale) is stubbed.
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
  vi.clearAllMocks();
});

describe("BackgroundView", () => {
  it("selecting a swatch sets a shader config", () => {
    const setBackgroundConfig = vi.fn();
    seed({ setBackgroundConfig });
    render(<BackgroundView />);
    fireEvent.click(screen.getByLabelText("Set background to Green"));
    expect(setBackgroundConfig).toHaveBeenCalledWith({
      mode: "shader",
      color: "#059669",
    });
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

  it("hides Generate when cloud is unavailable", () => {
    seed({ cloud: false });
    render(<BackgroundView />);
    expect(screen.queryByLabelText("Generate a background image")).toBeNull();
  });

  it("shows Generate when cloud is connected", () => {
    seed({ cloud: true });
    render(<BackgroundView />);
    expect(screen.getByLabelText("Generate a background image")).not.toBeNull();
  });

  it("uploading an image sets an image config", async () => {
    const setBackgroundConfig = vi.fn();
    seed({ setBackgroundConfig });
    render(<BackgroundView />);
    const input =
      document.querySelector<HTMLInputElement>('input[type="file"]');
    expect(input).not.toBeNull();
    const file = new File(["x"], "x.png", { type: "image/png" });
    fireEvent.change(input as HTMLInputElement, { target: { files: [file] } });
    await waitFor(() =>
      expect(setBackgroundConfig).toHaveBeenCalledWith({
        mode: "image",
        color: "#ef5a1f",
        imageUrl: "data:image/jpeg;base64,ZZZ",
      }),
    );
  });

  it("generates an image from a prompt and applies it", async () => {
    const setBackgroundConfig = vi.fn();
    const spy = vi
      .spyOn(client, "generateBackgroundImage")
      .mockResolvedValue({ url: "/api/media/gen.png" });
    seed({ cloud: true, setBackgroundConfig });
    render(<BackgroundView />);

    fireEvent.click(screen.getByLabelText("Generate a background image"));
    fireEvent.change(screen.getByPlaceholderText("Describe a background..."), {
      target: { value: "a calm beach" },
    });
    fireEvent.click(screen.getByLabelText("Generate background from prompt"));

    await waitFor(() => expect(spy).toHaveBeenCalledWith("a calm beach"));
    await waitFor(() =>
      expect(setBackgroundConfig).toHaveBeenCalledWith({
        mode: "image",
        color: "#ef5a1f",
        imageUrl: "/api/media/gen.png",
      }),
    );
    spy.mockRestore();
  });

  it("surfaces a generation error", async () => {
    const spy = vi
      .spyOn(client, "generateBackgroundImage")
      .mockRejectedValue(new Error("out of credits"));
    seed({ cloud: true });
    render(<BackgroundView />);

    fireEvent.click(screen.getByLabelText("Generate a background image"));
    fireEvent.change(screen.getByPlaceholderText("Describe a background..."), {
      target: { value: "anything" },
    });
    fireEvent.click(screen.getByLabelText("Generate background from prompt"));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("out of credits");
    spy.mockRestore();
  });
});
