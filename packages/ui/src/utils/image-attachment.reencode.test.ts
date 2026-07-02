// @vitest-environment jsdom
import { MAX_CHAT_IMAGE_BASE64_BYTES } from "@elizaos/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  filesToImageAttachments,
  UnsendableAttachmentError,
} from "./image-attachment";

/**
 * jsdom does not decode images, so stub `Image` to resolve immediately with
 * fixed dimensions (mirrors background-image.test.ts). Small dimensions keep
 * the thumbnail pass a no-op (its 512px bound ≥ the fake size → null) so these
 * tests exercise ONLY the re-encode path.
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

/** An Image whose decode always fails (e.g. HEIC outside Safari). */
class UndecodableImage {
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  width = 0;
  height = 0;
  set src(_value: string) {
    queueMicrotask(() => this.onerror?.());
  }
}

const SMALL_JPEG_DATA = "A".repeat(1_000);
const smallJpegDataUrl = `data:image/jpeg;base64,${SMALL_JPEG_DATA}`;
const overCapDataUrl = `data:image/jpeg;base64,${"B".repeat(
  MAX_CHAT_IMAGE_BASE64_BYTES + 4,
)}`;

let toDataURL: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.stubGlobal("Image", FakeImage);
  // readFileAsImageElement uses object URLs, which jsdom may not implement.
  const urlStatics = URL as unknown as {
    createObjectURL?: (blob: Blob) => string;
    revokeObjectURL?: (url: string) => void;
  };
  if (typeof urlStatics.createObjectURL !== "function") {
    urlStatics.createObjectURL = () => "blob:mock";
    urlStatics.revokeObjectURL = () => {};
  }
  // jsdom has no 2d context / JPEG encoder — supply both so the canvas path runs.
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    drawImage: vi.fn(),
  } as unknown as CanvasRenderingContext2D);
  toDataURL = vi
    .spyOn(HTMLCanvasElement.prototype, "toDataURL")
    .mockReturnValue(smallJpegDataUrl);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("filesToImageAttachments — client-side re-encode to the server cap", () => {
  it("converts a HEIC (non-allowlisted subtype) to a JPEG payload", async () => {
    const heic = new File([new Uint8Array([1, 2, 3])], "photo.heic", {
      type: "image/heic",
    });
    const [attachment] = await filesToImageAttachments([heic]);
    expect(attachment.mimeType).toBe("image/jpeg");
    expect(attachment.data).toBe(SMALL_JPEG_DATA);
    expect(attachment.name).toBe("photo.heic");
  });

  it("downscales an allowlisted JPEG whose base64 payload is over the server cap", async () => {
    // 4 MiB raw → ~5.6 MB of base64, over the 5 MiB server cap: exactly the
    // "typical phone photo" that used to 400 and destroy the message.
    const phonePhoto = new File(
      [new Uint8Array(4 * 1024 * 1024)],
      "IMG_1.jpg",
      {
        type: "image/jpeg",
      },
    );
    const [attachment] = await filesToImageAttachments([phonePhoto]);
    expect(attachment.mimeType).toBe("image/jpeg");
    expect(attachment.data).toBe(SMALL_JPEG_DATA);
    expect(attachment.data.length).toBeLessThanOrEqual(
      MAX_CHAT_IMAGE_BASE64_BYTES,
    );
  });

  it("passes a small allowlisted image through byte-for-byte (no re-encode)", async () => {
    const png = new File([new Uint8Array([1, 2, 3])], "pixel.png", {
      type: "image/png",
    });
    const [attachment] = await filesToImageAttachments([png]);
    expect(attachment.mimeType).toBe("image/png");
    // Base64 of [1,2,3] — the original bytes, untouched.
    expect(attachment.data).toBe("AQID");
    expect(toDataURL).not.toHaveBeenCalled();
  });

  it("steps down quality/dimensions until the payload fits the cap", async () => {
    toDataURL
      .mockReturnValueOnce(overCapDataUrl)
      .mockReturnValueOnce(smallJpegDataUrl);
    const heic = new File([new Uint8Array([1, 2, 3])], "photo.heic", {
      type: "image/heic",
    });
    const [attachment] = await filesToImageAttachments([heic]);
    expect(attachment.data).toBe(SMALL_JPEG_DATA);
    expect(toDataURL).toHaveBeenCalledTimes(2);
  });

  it("rejects with a clear pre-send error when the browser cannot decode the image", async () => {
    vi.stubGlobal("Image", UndecodableImage);
    const heic = new File([new Uint8Array([1, 2, 3])], "photo.heic", {
      type: "image/heic",
    });
    const rejection = filesToImageAttachments([heic]);
    await expect(rejection).rejects.toBeInstanceOf(UnsendableAttachmentError);
    await expect(rejection).rejects.toThrow(/photo\.heic/);
    await expect(rejection).rejects.toThrow(/Convert it to JPEG or PNG/);
  });

  it("rejects with a clear error when the image never fits the cap", async () => {
    toDataURL.mockReturnValue(overCapDataUrl);
    const heic = new File([new Uint8Array([1, 2, 3])], "huge.heic", {
      type: "image/heic",
    });
    const rejection = filesToImageAttachments([heic]);
    await expect(rejection).rejects.toBeInstanceOf(UnsendableAttachmentError);
    await expect(rejection).rejects.toThrow(
      /still too large after compression/,
    );
  });

  it("treats a canvas without a JPEG encoder as undecodable (never ships junk)", async () => {
    // jsdom's real toDataURL yields "data:," — the guard must reject rather
    // than send an empty payload the server would 400.
    toDataURL.mockReturnValue("data:,");
    const heic = new File([new Uint8Array([1, 2, 3])], "photo.heic", {
      type: "image/heic",
    });
    await expect(filesToImageAttachments([heic])).rejects.toBeInstanceOf(
      UnsendableAttachmentError,
    );
  });
});
