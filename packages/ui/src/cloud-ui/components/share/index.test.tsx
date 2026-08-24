/**
 * Verifies the cloud-ui share barrel's ShareButtons — clipboard copy state,
 * native-share delegation and fallback, and the social intent URLs — through
 * the package's configured jsdom harness.
 */
// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ShareButtons } from "./index";

function stubClipboard(behavior: "resolves" | "rejects") {
  const writeText = vi.fn(
    behavior === "resolves"
      ? () => Promise.resolve()
      : () => Promise.reject(new Error("denied")),
  );
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText },
    configurable: true,
  });
  return writeText;
}

function stubNativeShare() {
  const share = vi.fn(() => Promise.resolve());
  Object.defineProperty(navigator, "share", {
    value: share,
    configurable: true,
  });
  return share;
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  Reflect.deleteProperty(navigator, "clipboard");
  Reflect.deleteProperty(navigator, "share");
});

describe("ShareButtons (cloud-ui/components/share)", () => {
  it("renders the five sharing affordances from the barrel export", () => {
    render(<ShareButtons url="https://example.com/a" title="A post" />);

    for (const name of [
      "Share",
      "Copy Link",
      "Twitter",
      "LinkedIn",
      "Telegram",
    ]) {
      expect(screen.getByRole("button", { name })).not.toBeNull();
    }
  });

  it("writes the URL to the clipboard and flips the copy button to Copied!", async () => {
    const writeText = stubClipboard("resolves");
    render(<ShareButtons url="https://example.com/a" title="A post" />);

    fireEvent.click(screen.getByRole("button", { name: "Copy Link" }));
    await act(async () => {});

    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith("https://example.com/a");
    expect(screen.getByRole("button", { name: "Copied!" })).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Copy Link" })).toBeNull();
  });

  it("reverts the copy button to its idle label after two seconds", async () => {
    stubClipboard("resolves");
    vi.useFakeTimers();
    render(<ShareButtons url="https://example.com/a" title="A post" />);

    fireEvent.click(screen.getByRole("button", { name: "Copy Link" }));
    await act(async () => {});
    expect(screen.getByRole("button", { name: "Copied!" })).not.toBeNull();

    act(() => {
      vi.advanceTimersByTime(2000);
    });

    expect(screen.getByRole("button", { name: "Copy Link" })).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Copied!" })).toBeNull();
  });

  it("keeps the idle label when the clipboard write rejects", async () => {
    const writeText = stubClipboard("rejects");
    render(<ShareButtons url="https://example.com/a" title="A post" />);

    fireEvent.click(screen.getByRole("button", { name: "Copy Link" }));
    await act(async () => {});

    expect(writeText).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "Copied!" })).toBeNull();
    expect(screen.getByRole("button", { name: "Copy Link" })).not.toBeNull();
  });

  it("delegates the Share button to the native share API with title, description and URL", async () => {
    const share = stubNativeShare();
    render(
      <ShareButtons
        url="https://example.com/a"
        title="A post"
        description="about a"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Share" }));
    await act(async () => {});

    expect(share).toHaveBeenCalledTimes(1);
    expect(share).toHaveBeenCalledWith({
      title: "A post",
      text: "about a",
      url: "https://example.com/a",
    });
    // Native share consumed the interaction; the clipboard must stay untouched.
    expect(screen.queryByRole("button", { name: "Copied!" })).toBeNull();
  });

  it("falls back to copying the link when the native share API is unavailable", async () => {
    const writeText = stubClipboard("resolves");
    render(<ShareButtons url="https://example.com/a" title="A post" />);

    fireEvent.click(screen.getByRole("button", { name: "Share" }));
    await act(async () => {});

    expect(writeText).toHaveBeenCalledWith("https://example.com/a");
    expect(screen.getByRole("button", { name: "Copied!" })).not.toBeNull();
  });

  it("opens the Twitter intent with the encoded title, description and URL", async () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    render(
      <ShareButtons
        url="https://example.com/a b"
        title="A post & more"
        description="about it"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Twitter" }));
    await act(async () => {});

    expect(open).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith(
      "https://twitter.com/intent/tweet?text=A%20post%20%26%20more%20-%20about%20it&url=https%3A%2F%2Fexample.com%2Fa%20b",
      "_blank",
      "width=550,height=420",
    );
  });

  it("composes the Twitter text from the title alone when no description is given", async () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    render(<ShareButtons url="https://example.com/a" title="A post" />);

    fireEvent.click(screen.getByRole("button", { name: "Twitter" }));
    await act(async () => {});

    expect(open).toHaveBeenCalledWith(
      "https://twitter.com/intent/tweet?text=A%20post&url=https%3A%2F%2Fexample.com%2Fa",
      "_blank",
      "width=550,height=420",
    );
  });

  it("opens the LinkedIn share-offsite URL with the encoded URL", async () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    render(<ShareButtons url="https://example.com/a?x=1" title="A post" />);

    fireEvent.click(screen.getByRole("button", { name: "LinkedIn" }));
    await act(async () => {});

    expect(open).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith(
      "https://www.linkedin.com/sharing/share-offsite/?url=https%3A%2F%2Fexample.com%2Fa%3Fx%3D1",
      "_blank",
      "width=550,height=420",
    );
  });

  it("opens the Telegram share URL with the encoded URL and composed text", async () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    render(
      <ShareButtons
        url="https://example.com/tg"
        title="A post"
        description="see this"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Telegram" }));
    await act(async () => {});

    expect(open).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith(
      "https://t.me/share/url?url=https%3A%2F%2Fexample.com%2Ftg&text=A%20post%20-%20see%20this",
      "_blank",
      "width=550,height=420",
    );
  });
});
