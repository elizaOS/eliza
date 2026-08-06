import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildVisionUserMessages } from "./vision-input";

describe("buildVisionUserMessages", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "grok-vision-"));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("builds a multimodal user message when the prompt contains a local image path", async () => {
    const imagePath = path.join(tempDir, "screen.png");
    fs.writeFileSync(imagePath, Buffer.from([1, 2, 3, 4]));

    const messages = await buildVisionUserMessages(`Validate the image at ${imagePath}`, tempDir);

    expect(messages).toHaveLength(1);
    expect(messages[0]?.role).toBe("user");
    expect(Array.isArray(messages[0]?.content)).toBe(true);

    const content = messages[0]?.content as Array<Record<string, unknown>>;
    expect(content[0]).toMatchObject({
      type: "file",
      mediaType: "image/png",
    });
    expect(content[0]?.data).toBeInstanceOf(Uint8Array);
    expect(content[1]).toMatchObject({
      type: "text",
      text: `Validate the image at ${imagePath}`,
    });
  });

  it("recognizes shell-escaped screenshot paths", async () => {
    const imageName = "Screenshot 2026-05-06 at 10.02.18.png";
    const imagePath = path.join(tempDir, imageName);
    fs.writeFileSync(imagePath, Buffer.from([1, 2, 3, 4]));
    const escapedPath = path.join(tempDir, "Screenshot\\ 2026-05-06\\ at\\ 10.02.18.png");

    const messages = await buildVisionUserMessages(`${escapedPath}\nExplain this image`, tempDir);

    const content = messages[0]?.content as Array<Record<string, unknown>>;
    expect(content[0]).toMatchObject({
      type: "file",
      mediaType: "image/png",
    });
    expect(content[0]?.data).toBeInstanceOf(Uint8Array);
    expect(content[1]).toMatchObject({
      type: "text",
      text: `${escapedPath}\nExplain this image`,
    });
  });
});
