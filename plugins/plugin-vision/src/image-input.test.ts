import sharp from "sharp";
import { describe, expect, it } from "vitest";
import {
  assertSafeVisionDataImageUrl,
  assertValidVisionImageBuffer,
  estimateBase64DecodedBytes,
  MAX_VISION_IMAGE_BYTES,
  parseVisionDataImageUrl,
} from "./image-input";

async function makePng(): Promise<Buffer> {
  return sharp({
    create: {
      width: 2,
      height: 2,
      channels: 4,
      background: { r: 255, g: 0, b: 0, alpha: 1 },
    },
  })
    .png()
    .toBuffer();
}

describe("vision image input validation", () => {
  it("accepts supported encoded image buffers and reports content type", async () => {
    const png = await makePng();
    await expect(assertValidVisionImageBuffer(png)).resolves.toMatchObject({
      width: 2,
      height: 2,
      format: "png",
      contentType: "image/png",
    });
  });

  it("rejects empty and malformed image buffers before native/model use", async () => {
    await expect(assertValidVisionImageBuffer(Buffer.alloc(0))).rejects.toThrow(
      /non-empty Buffer/,
    );
    await expect(
      assertValidVisionImageBuffer(Buffer.from("not an image")),
    ).rejects.toThrow(/Malformed image input/);
  });

  it("rejects unsupported media types such as SVG even if sharp can parse them", async () => {
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"></svg>',
    );
    await expect(assertValidVisionImageBuffer(svg)).rejects.toThrow(
      /Unsupported image media type: svg/,
    );
  });

  it("rejects hostile URL schemes and non-base64 data payloads", () => {
    expect(() =>
      parseVisionDataImageUrl("https://example.test/image.png"),
    ).toThrow(/Only data image URLs/);
    expect(() =>
      parseVisionDataImageUrl("javascript:alert(1)"),
    ).toThrow(/Only data image URLs/);
    expect(() =>
      parseVisionDataImageUrl("data:image/png,not-base64"),
    ).toThrow(/must be base64/);
    expect(() =>
      parseVisionDataImageUrl("data:text/html;base64,PGgxPkJvb208L2gxPg=="),
    ).toThrow(/Unsupported image media type/);
  });

  it("rejects oversized base64 payloads without decoding them", () => {
    const payload = "A".repeat(Math.ceil((MAX_VISION_IMAGE_BYTES + 1) / 3) * 4);
    expect(estimateBase64DecodedBytes(payload)).toBeGreaterThan(
      MAX_VISION_IMAGE_BYTES,
    );
    expect(() =>
      parseVisionDataImageUrl(`data:image/jpeg;base64,${payload}`),
    ).toThrow(/exceeds/);
  });

  it("validates data URLs all the way through image metadata", async () => {
    const png = await makePng();
    await expect(
      assertSafeVisionDataImageUrl(
        `data:image/png;base64,${png.toString("base64")}`,
      ),
    ).resolves.toMatchObject({ contentType: "image/png" });
    await expect(
      assertSafeVisionDataImageUrl("data:image/png;base64,bm90LWFuLWltYWdl"),
    ).rejects.toThrow(/Malformed image input/);
  });
});
