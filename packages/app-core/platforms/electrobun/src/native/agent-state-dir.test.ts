import { describe, expect, it } from "vitest";
import {
  applyPackagedStartupEmbeddingWarmupPolicy,
  prependDesktopChildPathDirectory,
  resolveDesktopChildNamespace,
  resolveDesktopChildStateDir,
} from "./agent";

describe("desktop agent state dir", () => {
  it("uses the Milady XDG state root by default", () => {
    expect(
      resolveDesktopChildStateDir({
        env: { ELIZA_NAMESPACE: "milady" } as NodeJS.ProcessEnv,
        homedir: "/Users/example",
      }),
    ).toBe("/Users/example/.local/state/milady");
  });

  it("honors explicit Milady and elizaOS state dir overrides", () => {
    expect(
      resolveDesktopChildStateDir({
        env: { MILADY_STATE_DIR: "/tmp/milady-state" } as NodeJS.ProcessEnv,
      }),
    ).toBe("/tmp/milady-state");
    expect(
      resolveDesktopChildStateDir({
        env: {
          ELIZA_STATE_DIR: "/tmp/eliza-state",
          MILADY_STATE_DIR: "/tmp/milady-state",
        } as NodeJS.ProcessEnv,
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
});

describe("desktop child launch env", () => {
  it("does not require ELIZA_NAMESPACE to be present", () => {
    expect(resolveDesktopChildNamespace({})).toBe("eliza");
    expect(resolveDesktopChildNamespace({ ELIZA_NAMESPACE: "  custom  " })).toBe(
      "custom",
    );
  });

  it("does not let the shared eliza default override a branded package namespace", () => {
    expect(resolveDesktopChildNamespace({ ELIZA_NAMESPACE: "eliza" }, "milady"))
      .toBe("milady");
  });

  it("prepends Bun directory even when PATH is absent", () => {
    const env: Record<string, string | undefined> = {};

    expect(prependDesktopChildPathDirectory(env, "/opt/bun/bin")).toBe(true);
    expect(env.PATH).toBe("/opt/bun/bin");
    expect(prependDesktopChildPathDirectory(env, "/opt/bun/bin")).toBe(false);
    expect(env.PATH).toBe("/opt/bun/bin");
  });
});
