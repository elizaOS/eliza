/** Exercises agent state dir behavior with deterministic app-core test fixtures. */
import { describe, expect, it } from "vitest";
import {
  applyPackagedStartupEmbeddingWarmupPolicy,
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

describe("desktop packaged embedding warmup policy", () => {
  it("skips the large local embedding prefetch during packaged startup", () => {
    const env: Record<string, string> = {};

    applyPackagedStartupEmbeddingWarmupPolicy(env, true);

    expect(env.ELIZA_SKIP_LOCAL_EMBEDDING_WARMUP).toBe("1");
  });

  it("allows explicit startup embedding warmup opt-in", () => {
    const env: Record<string, string> = {
      ELIZA_ENABLE_STARTUP_LOCAL_EMBEDDING_WARMUP: "1",
    };

    applyPackagedStartupEmbeddingWarmupPolicy(env, true);

    expect(env.ELIZA_SKIP_LOCAL_EMBEDDING_WARMUP).toBeUndefined();
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
