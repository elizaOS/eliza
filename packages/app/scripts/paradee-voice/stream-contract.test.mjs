import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
test("Paradee stream cancellation retires queued work and callback reentry", () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "paradee-stream-contract-"),
  );
  try {
    execFileSync(
      "javac",
      [
        "-d",
        directory,
        path.resolve(
          here,
          "../../platforms/android/paradee-voice/src/main/java/ai/eliza/voice/ParadeeVoice.java",
        ),
        path.join(here, "stream-contract/VoiceNative.java"),
        path.join(here, "stream-contract/StreamContract.java"),
      ],
      { stdio: "pipe" },
    );
    execFileSync("java", ["-cp", directory, "ai.eliza.voice.StreamContract"], {
      stdio: "pipe",
      timeout: 15000,
    });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
