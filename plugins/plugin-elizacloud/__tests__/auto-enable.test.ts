import { describe, expect, it } from "vitest";
import { shouldEnable } from "../auto-enable";

type Ctx = Parameters<typeof shouldEnable>[0];

function ctxWithEnv(env: Record<string, string | undefined>): Ctx {
  return { env, config: {} } as Ctx;
}

describe("plugin-elizacloud auto-enable gate", () => {
  it("enables when a concrete ELIZAOS_CLOUD_API_KEY is set", () => {
    expect(shouldEnable(ctxWithEnv({ ELIZAOS_CLOUD_API_KEY: "ec_live_real-key" }))).toBe(true);
  });

  it("enables when the enabled flag is truthy", () => {
    for (const flag of ["1", "true", "yes", "TRUE", "Yes"]) {
      expect(
        shouldEnable(ctxWithEnv({ ELIZAOS_CLOUD_ENABLED: flag })),
        `ELIZAOS_CLOUD_ENABLED=${flag}`
      ).toBe(true);
    }
  });

  it("stays disabled when nothing is set", () => {
    expect(shouldEnable(ctxWithEnv({}))).toBe(false);
  });

  it("stays disabled for blank or whitespace-only keys", () => {
    expect(shouldEnable(ctxWithEnv({ ELIZAOS_CLOUD_API_KEY: "" }))).toBe(false);
    expect(shouldEnable(ctxWithEnv({ ELIZAOS_CLOUD_API_KEY: "   " }))).toBe(false);
  });

  it("rejects placeholder keys that previously spoofed the gate", () => {
    for (const placeholder of [
      "REDACTED",
      "[REDACTED]",
      "PLACEHOLDER",
      "TODO",
      "CHANGEME",
      "EMPTY",
      "changeme",
    ]) {
      expect(
        shouldEnable(ctxWithEnv({ ELIZAOS_CLOUD_API_KEY: placeholder })),
        `ELIZAOS_CLOUD_API_KEY=${placeholder}`
      ).toBe(false);
    }
  });

  it("does not treat non-truthy flag values as enabled", () => {
    for (const flag of ["0", "2", "false", "no", "off"]) {
      expect(
        shouldEnable(ctxWithEnv({ ELIZAOS_CLOUD_ENABLED: flag })),
        `ELIZAOS_CLOUD_ENABLED=${flag}`
      ).toBe(false);
    }
  });

  it("enables when the flag is truthy even with a placeholder key", () => {
    expect(
      shouldEnable(
        ctxWithEnv({
          ELIZAOS_CLOUD_API_KEY: "REDACTED",
          ELIZAOS_CLOUD_ENABLED: "1",
        })
      )
    ).toBe(true);
  });
});
