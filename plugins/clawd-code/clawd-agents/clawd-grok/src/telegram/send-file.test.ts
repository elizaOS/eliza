import { mkdtempSync, rmSync, writeFileSync } from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sendFileToTelegram, type TelegramFileContext } from "./send-file";

const tempDirs: string[] = [];

function createTempFile(name: string, sizeBytes = 16): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "grok-tg-sendfile-"));
  tempDirs.push(dir);
  const filePath = path.join(dir, name);
  writeFileSync(filePath, Buffer.alloc(sizeBytes, 1));
  return filePath;
}

function createCtx(overrides?: Partial<TelegramFileContext>): TelegramFileContext {
  return {
    api: {
      sendPhoto: vi.fn(async () => ({})),
      sendVideo: vi.fn(async () => ({})),
      sendAnimation: vi.fn(async () => ({})),
      sendDocument: vi.fn(async () => ({})),
    },
    chatId: 42,
    messageThreadId: 7,
    ...overrides,
  };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("sendFileToTelegram", () => {
  it("sends a PNG as a photo", async () => {
    const filePath = createTempFile("image.png");
    const ctx = createCtx();
    const result = await sendFileToTelegram(ctx, filePath);

    expect(result.success).toBe(true);
    expect(result.output).toContain("Sent photo");
    expect(ctx.api.sendPhoto).toHaveBeenCalledTimes(1);
    expect(ctx.api.sendDocument).not.toHaveBeenCalled();
  });

  it("sends a GIF as an animation", async () => {
    const filePath = createTempFile("anim.gif");
    const ctx = createCtx();
    const result = await sendFileToTelegram(ctx, filePath);

    expect(result.success).toBe(true);
    expect(result.output).toContain("Sent animation");
    expect(ctx.api.sendAnimation).toHaveBeenCalledTimes(1);
  });

  it("sends an MP4 as a video", async () => {
    const filePath = createTempFile("clip.mp4");
    const ctx = createCtx();
    const result = await sendFileToTelegram(ctx, filePath);

    expect(result.success).toBe(true);
    expect(result.output).toContain("Sent video");
    expect(ctx.api.sendVideo).toHaveBeenCalledTimes(1);
  });

  it("sends unknown extensions as a document", async () => {
    const filePath = createTempFile("report.pdf");
    const ctx = createCtx();
    const result = await sendFileToTelegram(ctx, filePath);

    expect(result.success).toBe(true);
    expect(result.output).toContain("Sent document");
    expect(ctx.api.sendDocument).toHaveBeenCalledTimes(1);
  });

  it("returns failure for missing files", async () => {
    const ctx = createCtx();
    const result = await sendFileToTelegram(ctx, "/tmp/does-not-exist.png");

    expect(result.success).toBe(false);
    expect(result.output).toContain("File not found");
  });

  it("returns failure when Telegram API throws", async () => {
    const filePath = createTempFile("broken.png");
    const ctx = createCtx();
    (ctx.api.sendPhoto as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("upload failed"));
    const result = await sendFileToTelegram(ctx, filePath);

    expect(result.success).toBe(false);
    expect(result.output).toContain("Failed to send");
    expect(result.output).toContain("upload failed");
  });
});
