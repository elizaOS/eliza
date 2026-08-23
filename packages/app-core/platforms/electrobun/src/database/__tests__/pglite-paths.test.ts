import { describe, expect, it } from "vitest";
import {
  assertSafePgliteResetTarget,
  describePglitePath,
  isMemoryPgliteDataDir,
  resolveDefaultPgliteDataDir,
  resolvePgliteDataDirPath,
} from "../pglite-paths.ts";

describe("isMemoryPgliteDataDir", () => {
  it("detects the memory sentinel with trimming", () => {
    expect(isMemoryPgliteDataDir("memory://")).toBe(true);
    expect(isMemoryPgliteDataDir("  memory://  ")).toBe(true);
    expect(isMemoryPgliteDataDir("/tmp/db")).toBe(false);
  });
});

describe("resolveDefaultPgliteDataDir", () => {
  it("joins appStateDir with the pglite path", () => {
    expect(resolveDefaultPgliteDataDir({ appStateDir: "/state" })).toBe(
      "/state/database/pglite",
    );
  });
});

describe("resolvePgliteDataDirPath", () => {
  it("keeps memory sentinel and absolute paths, resolves relative", () => {
    expect(resolvePgliteDataDirPath("memory://")).toBe("memory://");
    expect(resolvePgliteDataDirPath("/abs/db")).toBe("/abs/db");
    const rel = resolvePgliteDataDirPath("rel/db", "/cwd");
    expect(rel).toBe("/cwd/rel/db");
  });
});

describe("describePglitePath", () => {
  it("describes memory vs filesystem dirs", () => {
    const memory = describePglitePath("memory://", { appStateDir: "/state" });
    expect(memory.memory).toBe(true);
    const fs = describePglitePath("/abs/db", { appStateDir: "/state" });
    expect(fs.memory).toBe(false);
    expect(fs.dataDir).toBe("/abs/db");
  });
});

describe("assertSafePgliteResetTarget", () => {
  it("accepts a safe pglite path", () => {
    const resolved = assertSafePgliteResetTarget("/data/database/pglite");
    expect(resolved).toBe("/data/database/pglite");
  });

  it("rejects the filesystem root", () => {
    expect(() => assertSafePgliteResetTarget("/")).toThrow();
  });

  it("rejects non-pglite basenames", () => {
    expect(() => assertSafePgliteResetTarget("/data/other")).toThrow();
  });
});
