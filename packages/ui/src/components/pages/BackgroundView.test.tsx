// @vitest-environment jsdom
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
    color?: string;
  } = {},
) {
  __setAppValueForTests({
    backgroundConfig: { mode: "shader", color: opts.color ?? "#ef5a1f" },
    setBackgroundConfig: opts.setBackgroundConfig ?? vi.fn(),
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
    fireEvent.click(screen.getByLabelText("Set background color #2563eb"));
    expect(setBackgroundConfig).toHaveBeenCalledWith({
      mode: "shader",
      color: "#2563eb",
    });
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
    fireEvent.change(screen.getByPlaceholderText("Describe a background…"), {
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
    fireEvent.change(screen.getByPlaceholderText("Describe a background…"), {
      target: { value: "anything" },
    });
    fireEvent.click(screen.getByLabelText("Generate background from prompt"));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("out of credits");
    spy.mockRestore();
  });
});
