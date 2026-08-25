import { describe, expect, it } from "vitest";
import { shouldEnable } from "./auto-enable";

function ctx(env: Record<string, unknown>): {
  env: Record<string, unknown>;
  config: Record<string, never>;
} {
  return { env, config: {} };
}

describe("plugin-elizacloud auto-enable gate", () => {
  it("enables when an Eliza Cloud API key is present", () => {
    expect(
      shouldEnable(ctx({ ELIZAOS_CLOUD_API_KEY: "sk-live-123" }) as never),
    ).toBe(true);
  });

  it("disables when the API key is only whitespace", () => {
    expect(
      shouldEnable(ctx({ ELIZAOS_CLOUD_API_KEY: "   " }) as never),
    ).toBe(false);
  });

  it("enables when ELIZAOS_CLOUD_ENABLED is a truthy string", () => {
    for (const v of ["1", "true", "yes", "TRUE", " Yes "]) {
      expect(shouldEnable(ctx({ ELIZAOS_CLOUD_ENABLED: v }) as never)).toBe(
        true,
      );
    }
  });

  it("disables when ELIZAOS_CLOUD_ENABLED is a falsy string", () => {
    for (const v of ["0", "false", "no", ""]) {
      expect(shouldEnable(ctx({ ELIZAOS_CLOUD_ENABLED: v }) as never)).toBe(
        false,
      );
    }
  });

  it("disables when no cloud signal is present", () => {
    expect(shouldEnable(ctx({}) as never)).toBe(false);
  });

  it("tolerates non-string ELIZAOS_CLOUD_ENABLED values instead of throwing", () => {
    // `42` / `{}` are not strings; calling `.trim()` on them throws a
    // TypeError. The auto-enable engine treats a throwing predicate as
    // disabled-with-error, so a malformed value must fail closed cleanly.
    expect(shouldEnable(ctx({ ELIZAOS_CLOUD_ENABLED: 42 }) as never)).toBe(
      false,
    );
    expect(shouldEnable(ctx({ ELIZAOS_CLOUD_ENABLED: {} }) as never)).toBe(
      false,
    );
    expect(
      shouldEnable(ctx({ ELIZAOS_CLOUD_ENABLED: true }) as never),
    ).toBe(false);
  });

  it("tolerates non-string ELIZAOS_CLOUD_API_KEY values instead of throwing", () => {
    expect(shouldEnable(ctx({ ELIZAOS_CLOUD_API_KEY: 42 }) as never)).toBe(
      false,
    );
  });
});
