/** Exercises agent state dir behavior with deterministic app-core test fixtures
 *  against the real filesystem (temp dirs, real stat errors — no mocks). */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyPackagedStartupEmbeddingWarmupPolicy,
  migrateDesktopStateDirFromPath,
  prependDesktopChildPathDirectory,
  resolveDesktopChildNamespace,
  resolveDesktopChildStateDir,
} from "./agent";

describe("desktop agent state dir", () => {
  it("uses the namespaced XDG state root by default", () => {
    expect(
      resolveDesktopChildStateDir({
        env: { ELIZA_NAMESPACE: "example" } as NodeJS.ProcessEnv,
        homedir: "/Users/example",
      }),
    ).toBe("/Users/example/.local/state/example");
  });

  it("honors an explicit elizaOS state dir override", () => {
    expect(
      resolveDesktopChildStateDir({
        env: { ELIZA_STATE_DIR: "/tmp/eliza-state" } as NodeJS.ProcessEnv,
      }),
    ).toBe("/tmp/eliza-state");
  });
});

describe("migrateDesktopStateDirFromPath — source stat failures", () => {
  let tmpRoot: string;
  let targetDir: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-migrate-"));
    targetDir = path.join(tmpRoot, "target-state");
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("reports a genuinely-absent source as a successful skip", () => {
    const missing = path.join(tmpRoot, "does-not-exist");
    const result = migrateDesktopStateDirFromPath(missing, {
      env: { ELIZA_STATE_DIR: targetDir } as NodeJS.ProcessEnv,
    });
    expect(result.ok).toBe(true);
    expect(result.migrated).toBe(false);
    expect(result.skippedReason).toBe("source-missing");
    expect(result.error).toBeUndefined();
  });

  it("surfaces a non-ENOENT stat failure as ok:false, not a fake skip", () => {
    // A regular file used as a path *component* makes statSync throw ENOTDIR —
    // a real error that must NOT be fabricated into "source-missing" success.
    const filePath = path.join(tmpRoot, "not-a-dir");
    fs.writeFileSync(filePath, "x");
    const source = path.join(filePath, "child");

    const result = migrateDesktopStateDirFromPath(source, {
      env: { ELIZA_STATE_DIR: targetDir } as NodeJS.ProcessEnv,
    });

    expect(result.ok).toBe(false);
    expect(result.migrated).toBe(false);
    expect(result.skippedReason).toBeUndefined();
    expect(result.error).toBeTruthy();
  });
});

describe("desktop packaged embedding warmup policy", () => {
  it("skips the large local embedding prefetch during packaged startup", () => {
    const env: Record<string, string> = {};

    applyPackagedStartupEmbeddingWarmupPolicy(env, true);

    expect(env.ELIZA_SKIP_LOCAL_EMBEDDING_WARMUP).toBe("1");
  });

  it("allows explicit startup embedding warmup opt-in (disables the deferral in the child)", () => {
    const env: Record<string, string> = {
      ELIZA_ENABLE_STARTUP_LOCAL_EMBEDDING_WARMUP: "1",
    };

    applyPackagedStartupEmbeddingWarmupPolicy(env, true);

    expect(env.ELIZA_SKIP_LOCAL_EMBEDDING_WARMUP).toBeUndefined();
    // Runtime warmup defers by default, so the opt-in must force it off.
    expect(env.ELIZA_DEFER_LOCAL_EMBEDDING_WARMUP).toBe("0");
  });

  it("preserves explicit startup embedding skip when opt-in is also set", () => {
    const env: Record<string, string> = {
      ELIZA_ENABLE_STARTUP_LOCAL_EMBEDDING_WARMUP: "1",
      ELIZA_SKIP_LOCAL_EMBEDDING_WARMUP: "true",
    };

    applyPackagedStartupEmbeddingWarmupPolicy(env, true);

    expect(env.ELIZA_SKIP_LOCAL_EMBEDDING_WARMUP).toBe("true");
  });

  it("preserves explicit startup embedding warmup allow override", () => {
    const env: Record<string, string> = {
      ELIZA_SKIP_LOCAL_EMBEDDING_WARMUP: "0",
    };

    applyPackagedStartupEmbeddingWarmupPolicy(env, true);

    expect(env.ELIZA_SKIP_LOCAL_EMBEDDING_WARMUP).toBe("0");
  });
});

describe("desktop child launch env", () => {
  it("does not require ELIZA_NAMESPACE to be present", () => {
    expect(resolveDesktopChildNamespace({})).toBe("eliza");
    expect(
      resolveDesktopChildNamespace({ ELIZA_NAMESPACE: "  custom  " }),
    ).toBe("custom");
  });

  it("does not let the shared eliza default override a branded package namespace", () => {
    expect(
      resolveDesktopChildNamespace({ ELIZA_NAMESPACE: "eliza" }, "example"),
    ).toBe("example");
  });

  it("prepends Bun directory even when PATH is absent", () => {
    const env: Record<string, string | undefined> = {};

    expect(prependDesktopChildPathDirectory(env, "/opt/bun/bin")).toBe(true);
    expect(env.PATH).toBe("/opt/bun/bin");
    expect(prependDesktopChildPathDirectory(env, "/opt/bun/bin")).toBe(false);
    expect(env.PATH).toBe("/opt/bun/bin");
  });
});
