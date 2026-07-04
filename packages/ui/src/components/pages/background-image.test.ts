// @vitest-environment jsdom

/**
 * Unit tests for `fileToBackgroundDataUrl` — the image-to-data-URL conversion
 * behind the background picker. jsdom decodes no images and has no canvas, so
 * the harness stubs `Image` (see `FakeImage`) and asserts the pass-through path.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BackgroundImageError,
  fileToBackgroundDataUrl,
} from "./background-image";

/**
 * jsdom does not decode images, so stub `Image` to resolve immediately. With no
 * real canvas (`getContext` → null in jsdom) the helper returns the original
 * data URL, which is all these tests assert on.
 */
class FakeImage {
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  width = 100;
  height = 100;
  set src(_value: string) {
    queueMicrotask(() => this.onload?.());
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fileToBackgroundDataUrl", () => {
  it("rejects a non-image file", async () => {
    const file = new File(["plain"], "notes.txt", { type: "text/plain" });
    await expect(fileToBackgroundDataUrl(file)).rejects.toBeInstanceOf(
      BackgroundImageError,
    );
  });

  it("returns a data URL for an image file", async () => {
    vi.stubGlobal("Image", FakeImage);
    const file = new File([new Uint8Array([1, 2, 3])], "pic.png", {
      type: "image/png",
    });
    const url = await fileToBackgroundDataUrl(file);
    expect(url.startsWith("data:")).toBe(true);
  });

  it("rejects an image whose data URL exceeds the storage cap", async () => {
    vi.stubGlobal("Image", FakeImage);
    // ~5 MB of bytes → a base64 data URL well over the 4 MB cap.
    const big = new File([new Uint8Array(5 * 1024 * 1024)], "big.png", {
      type: "image/png",
    });
    await expect(fileToBackgroundDataUrl(big)).rejects.toBeInstanceOf(
      BackgroundImageError,
    );
  });
});
