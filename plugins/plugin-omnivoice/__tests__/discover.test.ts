import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { logger } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { discoverOmnivoiceModels } from "../src/discover";

function makeStateDir(): string {
  return mkdtempSync(join(tmpdir(), "omnivoice-discover-"));
}

function touch(path: string): void {
  writeFileSync(path, "");
}

describe("discoverOmnivoiceModels", () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = makeStateDir();
    vi.mocked(logger.warn).mockClear();
  });

  afterEach(() => {
    rmSync(stateDir, { force: true, recursive: true });
  });

  it("returns nulls for an empty state dir", () => {
    const result = discoverOmnivoiceModels({ stateDir });
    expect(result.speech).toBeNull();
    expect(result.singing).toBeNull();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("returns the speech pair when only speech files are present", () => {
    const speechDir = join(stateDir, "models", "omnivoice", "speech");
    mkdirSync(speechDir, { recursive: true });
    touch(join(speechDir, "omnivoice-base-Q8_0.gguf"));
    touch(join(speechDir, "omnivoice-tokenizer-F32.gguf"));

    const result = discoverOmnivoiceModels({ stateDir });
    expect(result.speech).toEqual({
      modelPath: join(speechDir, "omnivoice-base-Q8_0.gguf"),
      codecPath: join(speechDir, "omnivoice-tokenizer-F32.gguf"),
    });
    expect(result.singing).toBeNull();
  });

  it("returns both pairs when speech and singing are present", () => {
    const speechDir = join(stateDir, "models", "omnivoice", "speech");
    const singingDir = join(stateDir, "models", "omnivoice", "singing");
    mkdirSync(speechDir, { recursive: true });
    mkdirSync(singingDir, { recursive: true });
    touch(join(speechDir, "omnivoice-base-Q8_0.gguf"));
    touch(join(speechDir, "omnivoice-tokenizer-F32.gguf"));
    touch(join(singingDir, "omnivoice-singing-base-Q8_0.gguf"));
    touch(join(singingDir, "omnivoice-singing-tokenizer-F32.gguf"));

    const result = discoverOmnivoiceModels({ stateDir });
    expect(result.speech?.modelPath).toBe(
      join(speechDir, "omnivoice-base-Q8_0.gguf"),
    );
    expect(result.speech?.codecPath).toBe(
      join(speechDir, "omnivoice-tokenizer-F32.gguf"),
    );
    expect(result.singing?.modelPath).toBe(
      join(singingDir, "omnivoice-singing-base-Q8_0.gguf"),
    );
    expect(result.singing?.codecPath).toBe(
      join(singingDir, "omnivoice-singing-tokenizer-F32.gguf"),
    );
  });

  it("prefers quantized builds over F32 when both are present", () => {
    const speechDir = join(stateDir, "models", "omnivoice", "speech");
    mkdirSync(speechDir, { recursive: true });
    touch(join(speechDir, "omnivoice-base-F32.gguf"));
    touch(join(speechDir, "omnivoice-base-Q8_0.gguf"));
    touch(join(speechDir, "omnivoice-tokenizer-F32.gguf"));

    const result = discoverOmnivoiceModels({ stateDir });
    expect(result.speech?.modelPath).toBe(
      join(speechDir, "omnivoice-base-Q8_0.gguf"),
    );
  });

  it("returns null and warns when only unrecognized GGUF filenames are present", () => {
    const speechDir = join(stateDir, "models", "omnivoice", "speech");
    mkdirSync(speechDir, { recursive: true });
    touch(join(speechDir, "weird-name.gguf"));
    touch(join(speechDir, "another-blob.gguf"));

    const result = discoverOmnivoiceModels({ stateDir });
    expect(result.speech).toBeNull();
    expect(logger.warn).toHaveBeenCalled();
    const calls = vi.mocked(logger.warn).mock.calls;
    expect(calls.some((args) => String(args[0]).includes("unrecognized"))).toBe(
      true,
    );
  });

  it("returns null when only a model is present without a codec", () => {
    const speechDir = join(stateDir, "models", "omnivoice", "speech");
    mkdirSync(speechDir, { recursive: true });
    touch(join(speechDir, "omnivoice-base-Q8_0.gguf"));

    const result = discoverOmnivoiceModels({ stateDir });
    expect(result.speech).toBeNull();
  });

  it("ignores non-gguf files", () => {
    const speechDir = join(stateDir, "models", "omnivoice", "speech");
    mkdirSync(speechDir, { recursive: true });
    touch(join(speechDir, "manifest.json"));
    touch(join(speechDir, "README.md"));

    const result = discoverOmnivoiceModels({ stateDir });
    expect(result.speech).toBeNull();
    expect(logger.warn).not.toHaveBeenCalled();
  });
});
