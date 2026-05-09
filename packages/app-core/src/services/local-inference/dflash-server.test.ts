import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  dflashEnabled,
  getDflashRuntimeStatus,
  resolveDflashBinary,
} from "./dflash-server";

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
});

function makeManagedBinary(root: string): string {
  const managed = path.join(
    root,
    "local-inference",
    "bin",
    "dflash",
    `${process.platform}-${process.arch}-${process.platform === "darwin" ? "metal" : "cuda"}`,
    "llama-server",
  );
  fs.mkdirSync(path.dirname(managed), { recursive: true });
  fs.writeFileSync(managed, "#!/bin/sh\n", "utf8");
  fs.chmodSync(managed, 0o755);
  return managed;
}

describe("DFlash runtime discovery", () => {
  it("auto-enables when the managed binary exists", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-dflash-test-"));
    process.env.ELIZA_STATE_DIR = root;
    delete process.env.ELIZA_DFLASH_ENABLED;
    delete process.env.ELIZA_DFLASH_DISABLED;
    delete process.env.HIP_VISIBLE_DEVICES;
    delete process.env.ROCR_VISIBLE_DEVICES;
    delete process.env.CUDA_VISIBLE_DEVICES;
    const binary = makeManagedBinary(root);

    expect(dflashEnabled()).toBe(true);
    expect(resolveDflashBinary()).toBe(binary);
    expect(getDflashRuntimeStatus().enabled).toBe(true);
  });

  it("does not use PATH llama-server unless explicitly enabled", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-dflash-test-"));
    const binDir = path.join(root, "bin");
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(path.join(binDir, "llama-server"), "#!/bin/sh\n", "utf8");
    fs.chmodSync(path.join(binDir, "llama-server"), 0o755);
    process.env.ELIZA_STATE_DIR = root;
    process.env.PATH = `${binDir}${path.delimiter}${originalEnv.PATH ?? ""}`;
    delete process.env.ELIZA_DFLASH_ENABLED;
    delete process.env.HIP_VISIBLE_DEVICES;
    delete process.env.ROCR_VISIBLE_DEVICES;
    delete process.env.CUDA_VISIBLE_DEVICES;

    expect(dflashEnabled()).toBe(false);
    expect(resolveDflashBinary()).toBe(null);

    process.env.ELIZA_DFLASH_ENABLED = "1";
    expect(resolveDflashBinary()).toBe(path.join(binDir, "llama-server"));
  });
});
