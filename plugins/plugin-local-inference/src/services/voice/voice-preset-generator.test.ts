import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  readVoicePresetFile,
  VoicePresetFormatError,
} from "./voice-preset-format";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// .../packages/app-core/src/services/local-inference/voice -> packages/app-core
const APP_CORE_ROOT = path.resolve(HERE, "../../../..");
const SCRIPT = path.join(
  APP_CORE_ROOT,
  "scripts",
  "voice-preset",
  "build-default-voice-preset.mjs",
);

function runGenerator(args: string[]): string {
  return execFileSync("bun", [SCRIPT, ...args], {
    cwd: APP_CORE_ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

describe("build-default-voice-preset.mjs", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "eliza-voice-preset-gen-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("--placeholder writes a format-valid .bin that round-trips through readVoicePresetFile", () => {
    expect(existsSync(SCRIPT)).toBe(true);
    const out = path.join(dir, "voice-preset-default.bin");
    const stdout = runGenerator(["--placeholder", "--out", out]);
    expect(stdout).toMatch(/PLACEHOLDER/);
    expect(existsSync(out)).toBe(true);

    const parsed = readVoicePresetFile(new Uint8Array(readFileSync(out)));
    expect(parsed.version).toBe(1);
    // Default placeholder embedding dim is 256, all zeros.
    expect(parsed.embedding.length).toBe(256);
    expect(parsed.embedding.every((x) => x === 0)).toBe(true);
    // Placeholder carries no audio.
    expect(parsed.phrases).toHaveLength(0);
  });

  it("--placeholder --dim N honours the embedding dimension", () => {
    const out = path.join(dir, "p.bin");
    runGenerator(["--placeholder", "--dim", "64", "--out", out]);
    const parsed = readVoicePresetFile(new Uint8Array(readFileSync(out)));
    expect(parsed.embedding.length).toBe(64);
  });

  it("refuses to build a real preset without an embedding (exit 2, guidance message)", () => {
    let threw = false;
    try {
      execFileSync("bun", [SCRIPT], {
        cwd: APP_CORE_ROOT,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      threw = true;
      const e = err as { status?: number; stderr?: string };
      expect(e.status).toBe(2);
      expect(e.stderr ?? "").toMatch(/--embedding/);
      expect(e.stderr ?? "").toMatch(/--placeholder/);
    }
    expect(threw).toBe(true);
  });

  // Sanity: a truncated file is rejected by the parser the generator uses.
  it("the parser the generator targets rejects a truncated blob", () => {
    expect(() => readVoicePresetFile(new Uint8Array([1, 2, 3]))).toThrow(
      VoicePresetFormatError,
    );
  });
});
