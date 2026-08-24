/**
 * Verifies Electrobun PGlite path resolution and reset-target safety with deterministic filesystem-independent inputs.
 */
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

const { ensurePgliteDataDir } = await import("../pglite-paths.ts");
const fs = await import("node:fs");
const os = await import("node:os");
const path = await import("node:path");

/** Runs a body inside a fresh temporary directory that is always removed. */
async function withTempDir(
  run: (dir: string) => void | Promise<void>,
): Promise<void> {
  const dir = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "eliza-pglite-paths-"),
  );
  try {
    await run(dir);
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
}

function withProcessCwd(fakeCwd: string, run: () => void): void {
  const originalCwd = process.cwd;
  process.cwd = () => fakeCwd;
  try {
    run();
  } finally {
    process.cwd = originalCwd;
  }
}

describe("isMemoryPgliteDataDir sentinel strictness", () => {
  it("accepts whitespace padding but rejects case and suffix variants", () => {
    expect(isMemoryPgliteDataDir("\tmemory://\n")).toBe(true);
    expect(isMemoryPgliteDataDir("MEMORY://")).toBe(false);
    expect(isMemoryPgliteDataDir("memory:/")).toBe(false);
    expect(isMemoryPgliteDataDir("memory://db")).toBe(false);
    expect(isMemoryPgliteDataDir("")).toBe(false);
  });
});

describe("resolveDefaultPgliteDataDir normalization", () => {
  it("collapses trailing separators in appStateDir", () => {
    expect(resolveDefaultPgliteDataDir({ appStateDir: "/tmp/state/" })).toBe(
      "/tmp/state/database/pglite",
    );
  });
});

describe("resolvePgliteDataDirPath trimming and defaults", () => {
  it("trims whitespace around absolute paths", () => {
    expect(resolvePgliteDataDirPath("  /abs/db\n")).toBe("/abs/db");
  });

  it("returns the canonical memory sentinel for padded input", () => {
    expect(resolvePgliteDataDirPath("  memory://\t")).toBe("memory://");
  });

  it("resolves empty and whitespace-only input to cwd", () => {
    expect(resolvePgliteDataDirPath("", "/cwd")).toBe("/cwd");
    expect(resolvePgliteDataDirPath("   ", "/cwd")).toBe("/cwd");
  });

  it("normalizes dot segments against the explicit cwd", () => {
    expect(resolvePgliteDataDirPath(".", "/cwd")).toBe("/cwd");
    expect(resolvePgliteDataDirPath("db/../pglite", "/cwd")).toBe(
      "/cwd/pglite",
    );
    expect(resolvePgliteDataDirPath("../up", "/cwd/inner")).toBe("/cwd/up");
  });

  it("falls back to process.cwd() when cwd is omitted", () => {
    withProcessCwd("/mock/cwd", () => {
      expect(resolvePgliteDataDirPath("rel/db")).toBe("/mock/cwd/rel/db");
    });
  });
});

describe("ensurePgliteDataDir", () => {
  it("is a no-op for the padded memory sentinel", () => {
    expect(() => ensurePgliteDataDir("  memory://  ")).not.toThrow();
  });

  it("creates a missing data directory recursively", async () => {
    await withTempDir((dir) => {
      const dataDir = path.join(dir, "database", "pglite");
      ensurePgliteDataDir(dataDir);
      expect(fs.existsSync(dataDir)).toBe(true);
      fs.accessSync(dataDir, fs.constants.W_OK);
    });
  });

  it("resolves a relative data directory against process.cwd()", async () => {
    await withTempDir((dir) => {
      withProcessCwd(dir, () => {
        ensurePgliteDataDir("relative/pglite");
      });
      expect(fs.existsSync(path.join(dir, "relative", "pglite"))).toBe(true);
    });
  });

  it("propagates mkdir failures when a parent component is a file", async () => {
    await withTempDir((dir) => {
      const blocker = path.join(dir, "blocker");
      fs.writeFileSync(blocker, "not a directory");
      expect(() =>
        ensurePgliteDataDir(path.join(blocker, "pglite")),
      ).toThrowError();
    });
  });

  it("propagates access failures for read-only directories", async () => {
    await withTempDir((dir) => {
      const locked = path.join(dir, "locked");
      fs.mkdirSync(locked, { recursive: true });
      fs.chmodSync(locked, 0o500);
      try {
        expect(() => ensurePgliteDataDir(locked)).toThrowError();
      } finally {
        fs.chmodSync(locked, 0o700);
      }
    });
  });
});

describe("describePglitePath containment and writability", () => {
  it("describes the padded memory sentinel without probing the filesystem", () => {
    expect(
      describePglitePath("  memory://  ", { appStateDir: "/state" }),
    ).toEqual({
      dataDir: "memory://",
      insideAppState: false,
      insideAppBundle: false,
      memory: true,
      writableParent: true,
    });
  });

  it("describes an app-state root equal to appStateDir", async () => {
    await withTempDir((dir) => {
      expect(describePglitePath(dir, { appStateDir: dir })).toEqual({
        dataDir: dir,
        insideAppState: true,
        insideAppBundle: false,
        memory: false,
        writableParent: true,
      });
    });
  });

  it("treats descendants as inside app state", async () => {
    await withTempDir((dir) => {
      const nested = path.join(dir, "database", "pglite");
      const description = describePglitePath(nested, { appStateDir: dir });
      expect(description.insideAppState).toBe(true);
      expect(description.memory).toBe(false);
    });
  });

  it("does not treat textual-prefix siblings as inside app state", async () => {
    await withTempDir((dir) => {
      const description = describePglitePath(path.join(`${dir}-backup`, "db"), {
        appStateDir: dir,
      });
      expect(description.insideAppState).toBe(false);
    });
  });

  it("marks paths outside app state accordingly", async () => {
    await withTempDir((dir) => {
      const elsewhere = path.join(dir, "elsewhere", "db");
      const description = describePglitePath(elsewhere, {
        appStateDir: path.join(dir, "state"),
      });
      expect(description.insideAppState).toBe(false);
    });
  });

  it("detects macOS app bundle containment by path marker", async () => {
    await withTempDir((dir) => {
      const bundled = path.join(
        dir,
        "Eliza.app",
        "Contents",
        "Resources",
        "pglite",
      );
      const description = describePglitePath(bundled, { appStateDir: dir });
      expect(description.insideAppBundle).toBe(true);

      const unbundled = path.join(dir, "Eliza.app", "Resources", "pglite");
      expect(
        describePglitePath(unbundled, { appStateDir: dir }).insideAppBundle,
      ).toBe(false);
    });
  });

  it("creates a missing parent and reports it writable", async () => {
    await withTempDir((dir) => {
      const dataDir = path.join(dir, "deeply", "nested", "pglite");
      const description = describePglitePath(dataDir, { appStateDir: dir });
      expect(description.writableParent).toBe(true);
      expect(fs.existsSync(path.dirname(dataDir))).toBe(true);
    });
  });

  it("reports an unwritable parent instead of throwing", async () => {
    await withTempDir((dir) => {
      const locked = path.join(dir, "locked");
      fs.mkdirSync(locked, { recursive: true });
      fs.chmodSync(locked, 0o500);
      try {
        const description = describePglitePath(path.join(locked, "pglite"), {
          appStateDir: dir,
        });
        expect(description.writableParent).toBe(false);
      } finally {
        fs.chmodSync(locked, 0o700);
      }
    });
  });

  it("reports an uncreatable parent instead of throwing", async () => {
    await withTempDir((dir) => {
      const blocker = path.join(dir, "blocker");
      fs.writeFileSync(blocker, "occupies the parent slot");
      const description = describePglitePath(path.join(blocker, "pglite"), {
        appStateDir: dir,
      });
      expect(description.writableParent).toBe(false);
    });
  });
});

describe("assertSafePgliteResetTarget branches", () => {
  it("rejects the padded memory sentinel with a dedicated error", () => {
    expect(() => assertSafePgliteResetTarget("  memory://\n")).toThrowError(
      "memory:// PGlite data cannot be backed up or reset.",
    );
  });

  it("accepts the .elizadb basename", () => {
    expect(assertSafePgliteResetTarget("/data/backups/.elizadb")).toBe(
      "/data/backups/.elizadb",
    );
  });

  it("resolves relative targets against process.cwd()", () => {
    withProcessCwd("/mock/cwd", () => {
      expect(assertSafePgliteResetTarget("database/pglite")).toBe(
        "/mock/cwd/database/pglite",
      );
    });
  });

  it("keeps a trailing separator instead of normalizing it", () => {
    expect(assertSafePgliteResetTarget("/data/database/pglite/")).toBe(
      "/data/database/pglite/",
    );
  });

  it("rejects the filesystem root as too broad", () => {
    expect(() => assertSafePgliteResetTarget("/")).toThrowError(
      "PGlite reset target is too broad.",
    );
  });

  it("names the offending path for disallowed basenames", () => {
    expect(() =>
      assertSafePgliteResetTarget("/data/pglite-backup"),
    ).toThrowError(
      "PGlite reset target must end in pglite or .elizadb: /data/pglite-backup",
    );
    expect(() =>
      assertSafePgliteResetTarget("/data/.elizadb-old"),
    ).toThrowError(/must end in pglite or \.elizadb/);
  });

  it("rejects allowed basenames inside an app bundle", () => {
    expect(() =>
      assertSafePgliteResetTarget(
        "/Applications/Eliza.app/Contents/Resources/pglite",
      ),
    ).toThrowError("PGlite reset target cannot be inside an app bundle.");
  });
});
