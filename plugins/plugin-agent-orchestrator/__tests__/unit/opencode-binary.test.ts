import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  opencodeCommandName,
  resolveOpencodeBinary,
} from "../../src/services/opencode-binary.ts";

const previousOpencodeBin = process.env.ELIZA_OPENCODE_BIN;
const tempDirs: string[] = [];

afterEach(() => {
  if (previousOpencodeBin === undefined) {
    delete process.env.ELIZA_OPENCODE_BIN;
  } else {
    process.env.ELIZA_OPENCODE_BIN = previousOpencodeBin;
  }

  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("opencode binary resolution", () => {
  it("prefers an explicit ELIZA_OPENCODE_BIN executable", () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "opencode-bin-"));
    tempDirs.push(tempDir);
    const binary = path.join(
      tempDir,
      process.platform === "win32" ? "opencode.exe" : "opencode",
    );
    writeFileSync(binary, "");
    chmodSync(binary, 0o755);
    process.env.ELIZA_OPENCODE_BIN = binary;

    expect(resolveOpencodeBinary()).toBe(binary);
    expect(opencodeCommandName()).toBe(binary);
  });
});
