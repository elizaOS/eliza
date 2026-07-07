/** Exercises desktop startup embedding warmup policy behavior with deterministic app-core test fixtures. */
import { describe, expect, it } from "vitest";

import { resolveDesktopStartupEmbeddingWarmupPolicy } from "./desktop-startup-embedding-warmup-policy.mjs";

describe("desktop startup embedding warmup policy", () => {
  it("defaults desktop startup to deferred background GGUF embedding warmup", () => {
    const policy = resolveDesktopStartupEmbeddingWarmupPolicy({});

    expect(policy.env).toEqual({ ELIZA_DEFER_LOCAL_EMBEDDING_WARMUP: "1" });
    expect(policy.effective).toBe("deferred background");
    expect(policy.source).toContain("desktop dev fast startup");
  });

  it("skips startup embedding warmup by default in CI", () => {
    const policy = resolveDesktopStartupEmbeddingWarmupPolicy({ CI: "true" });

    expect(policy.env).toEqual({ ELIZA_SKIP_LOCAL_EMBEDDING_WARMUP: "1" });
    expect(policy.effective).toBe("skipped");
    expect(policy.source).toContain("CI");
  });

  it("allows explicit startup embedding warmup opt-in (defers off in the child)", () => {
    const policy = resolveDesktopStartupEmbeddingWarmupPolicy({
      ELIZA_ENABLE_STARTUP_LOCAL_EMBEDDING_WARMUP: "1",
    });

    // Runtime warmup now defers by default, so the opt-in must inject an
    // explicit defer-off into the child to reach the process-entry warmup.
    expect(policy.env).toEqual({ ELIZA_DEFER_LOCAL_EMBEDDING_WARMUP: "0" });
    expect(policy.effective).toBe("startup background");
    expect(policy.source).toContain(
      "ELIZA_ENABLE_STARTUP_LOCAL_EMBEDDING_WARMUP=1",
    );
  });

  it("preserves an explicit skip override ahead of the opt-in alias", () => {
    const policy = resolveDesktopStartupEmbeddingWarmupPolicy({
      ELIZA_ENABLE_STARTUP_LOCAL_EMBEDDING_WARMUP: "1",
      ELIZA_SKIP_LOCAL_EMBEDDING_WARMUP: "true",
    });

    expect(policy.env).toEqual({
      ELIZA_SKIP_LOCAL_EMBEDDING_WARMUP: "true",
    });
    expect(policy.effective).toBe("skipped");
    expect(policy.source).toContain("ELIZA_SKIP_LOCAL_EMBEDDING_WARMUP=true");
  });

  it("preserves an explicit false skip override", () => {
    const policy = resolveDesktopStartupEmbeddingWarmupPolicy({
      ELIZA_SKIP_LOCAL_EMBEDDING_WARMUP: "0",
    });

    expect(policy.env).toEqual({ ELIZA_SKIP_LOCAL_EMBEDDING_WARMUP: "0" });
    expect(policy.effective).toBe("startup background");
  });
});
