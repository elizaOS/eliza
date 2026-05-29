import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyBundledWhisperEnv,
  resolveBundledWhisperRuntime,
} from "./whisper-env";

const tmpDirs: string[] = [];

function makeRuntimeDist(platform: NodeJS.Platform = "darwin"): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "milady-whisper-env-"));
  tmpDirs.push(root);
  const dir = path.join(root, "voice", "whisper");
  fs.mkdirSync(dir, { recursive: true });
  const lib =
    platform === "win32"
      ? "whisper_eliza_adapter.dll"
      : platform === "darwin"
        ? "libwhisper_eliza_adapter.dylib"
        : "libwhisper_eliza_adapter.so";
  fs.writeFileSync(path.join(dir, lib), "lib");
  fs.writeFileSync(path.join(dir, "ggml-base.en.bin"), "model");
  return root;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("bundled Whisper desktop env", () => {
  it("resolves the packaged adapter and model from runtime dist", () => {
    const runtimeDist = makeRuntimeDist("darwin");

    expect(resolveBundledWhisperRuntime(runtimeDist, "darwin")).toEqual({
      directory: path.join(runtimeDist, "voice", "whisper"),
      libraryPath: path.join(
        runtimeDist,
        "voice",
        "whisper",
        "libwhisper_eliza_adapter.dylib",
      ),
      modelPath: path.join(runtimeDist, "voice", "whisper", "ggml-base.en.bin"),
    });
  });

  it("sets child env without overwriting explicit Whisper overrides", () => {
    const runtimeDist = makeRuntimeDist("linux");
    const env: Record<string, string> = {
      ELIZA_WHISPER_LIBRARY: "/custom/lib.so",
      PATH: "/bin",
    };

    const runtime = applyBundledWhisperEnv(env, runtimeDist, "linux");

    expect(runtime?.modelPath).toBe(
      path.join(runtimeDist, "voice", "whisper", "ggml-base.en.bin"),
    );
    expect(env.ELIZA_WHISPER_LIBRARY).toBe("/custom/lib.so");
    expect(env.ELIZA_WHISPER_MODEL).toBe(
      path.join(runtimeDist, "voice", "whisper", "ggml-base.en.bin"),
    );
    expect(env.ELIZA_LOCAL_ASR_ALLOW_WHISPER_CPP).toBe("1");
    expect(env.LD_LIBRARY_PATH).toBe(
      path.join(runtimeDist, "voice", "whisper"),
    );
  });
});
