import { describe, expect, it } from "vitest";
import {
  normalizeLlmCallPayload,
  redactTrajectoryText,
  shouldEnableTrajectoryLoggingByDefault,
} from "./trajectory-internals.ts";

describe("redactTrajectoryText", () => {
  it("strips emails, API keys, and ETH addresses", () => {
    const input =
      "contact me at user@example.com using key sk-abcdefghijklmnopqrstuv and wallet 0x" +
      "a".repeat(40);
    const out = redactTrajectoryText(input);
    expect(out).not.toContain("user@example.com");
    expect(out).not.toContain("sk-abcdefghijklmnopqrstuv");
    expect(out).not.toContain(`0x${"a".repeat(40)}`);
    expect(out).toContain("<EMAIL>");
    expect(out).toContain("<API_KEY>");
    expect(out).toContain("<ETH_ADDR>");
  });

  it("returns non-string values unchanged", () => {
    expect(redactTrajectoryText(42)).toBe(42);
    expect(redactTrajectoryText(null)).toBe(null);
  });
});

describe("normalizeLlmCallPayload redaction", () => {
  it("redacts known sensitive fields in the payload", () => {
    const result = normalizeLlmCallPayload([
      {
        stepId: "s-1",
        userPrompt: "send to user@example.com",
        response: "ok",
      },
    ]);
    expect(result).not.toBeNull();
    expect(result?.params.userPrompt).toBe("send to <EMAIL>");
    // Non-sensitive content untouched.
    expect(result?.params.response).toBe("ok");
  });
});

describe("shouldEnableTrajectoryLoggingByDefault", () => {
  it("returns false in NODE_ENV=production without explicit opt-in", () => {
    expect(
      shouldEnableTrajectoryLoggingByDefault({
        NODE_ENV: "production",
      } as NodeJS.ProcessEnv),
    ).toBe(false);
  });

  it("returns true in NODE_ENV=production when ELIZA_TRAJECTORY_LOGGING=1", () => {
    expect(
      shouldEnableTrajectoryLoggingByDefault({
        NODE_ENV: "production",
        ELIZA_TRAJECTORY_LOGGING: "1",
      } as NodeJS.ProcessEnv),
    ).toBe(true);
  });

  it("returns false in NODE_ENV=test", () => {
    expect(
      shouldEnableTrajectoryLoggingByDefault({
        NODE_ENV: "test",
      } as NodeJS.ProcessEnv),
    ).toBe(false);
  });
});
