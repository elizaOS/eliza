/**
 * Isolated hang/overflow tests for the audio-redaction child runner. Spawns
 * real runtime children; does not import ffmpeg or the media store.
 */
import { describe, expect, it } from "vitest";
import { runAudioRedactionChild } from "./audio-redaction-child.ts";

describe("runAudioRedactionChild", () => {
  it("kills a hung child at the timeout instead of waiting forever", async () => {
    const startedAt = Date.now();
    await expect(
      runAudioRedactionChild(
        process.execPath,
        ["-e", "setTimeout(() => {}, 8_000)"],
        { timeoutMs: 200 },
      ),
    ).rejects.toMatchObject({
      name: "AudioRedactionChildError",
      code: "AUDIO_REDACTION_TIMEOUT",
    });
    expect(Date.now() - startedAt).toBeLessThan(1500);
  });

  it("rejects a child that dumps more than the stdio budget", async () => {
    await expect(
      runAudioRedactionChild(
        process.execPath,
        ["-e", "process.stdout.write('x'.repeat(4096))"],
        { timeoutMs: 2000, maxStdioBytes: 1024 },
      ),
    ).rejects.toMatchObject({
      name: "AudioRedactionChildError",
      code: "AUDIO_REDACTION_STDIO_OVERFLOW",
    });
  });

  it("returns stdout from a last-fit short child", async () => {
    const result = await runAudioRedactionChild(
      process.execPath,
      ["-e", "process.stdout.write('ok')"],
      { timeoutMs: 2000, maxStdioBytes: 1024 },
    );
    expect(result).toMatchObject({ code: 0, stdout: "ok" });
  });
});
