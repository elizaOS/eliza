import { afterEach, beforeEach, describe, expect, test } from "bun:test";

const originalDateNow = Date.now;
let nowMs = 1_800_000_000_000;
let originalNodeEnv: string | undefined;
let originalRedisUrl: string | undefined;

beforeEach(() => {
  originalNodeEnv = process.env.NODE_ENV;
  originalRedisUrl = process.env.REDIS_URL;
  nowMs = 1_800_000_000_000;
  Date.now = () => nowMs;
  delete process.env.REDIS_URL;
  process.env.NODE_ENV = "test";
});

afterEach(() => {
  Date.now = originalDateNow;
  if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = originalNodeEnv;
  if (originalRedisUrl === undefined) delete process.env.REDIS_URL;
  else process.env.REDIS_URL = originalRedisUrl;
});

describe("in-memory revocation line monotonicity", () => {
  test("a newer line cannot shorten the active expiry", async () => {
    const { revocationStore } = await import(
      `../revocation?newer=${crypto.randomUUID()}`
    );
    await revocationStore.revokeAgentTokens(
      "agent-newer-shorter",
      200,
      nowMs + 10_000,
    );
    await revocationStore.revokeAgentTokens(
      "agent-newer-shorter",
      300,
      nowMs + 1_000,
    );

    nowMs += 2_000;
    await expect(
      revocationStore.getAgentRevokedBefore("agent-newer-shorter"),
    ).resolves.toBe(300);
  });

  test("a stale line can extend but cannot lower the active line", async () => {
    const { revocationStore } = await import(
      `../revocation?stale=${crypto.randomUUID()}`
    );
    await revocationStore.revokeUserTokens(
      "user-stale-longer",
      300,
      nowMs + 1_000,
    );
    await revocationStore.revokeUserTokens(
      "user-stale-longer",
      200,
      nowMs + 10_000,
    );

    nowMs += 2_000;
    await expect(
      revocationStore.getUserRevokedBefore("user-stale-longer"),
    ).resolves.toBe(300);
  });

  test("an expired high line cannot suppress a fresh lower line", async () => {
    const { revocationStore } = await import(
      `../revocation?expired=${crypto.randomUUID()}`
    );
    await revocationStore.revokeAgentTokens(
      "agent-expired-line",
      300,
      nowMs + 1_000,
    );

    nowMs += 2_000;
    await revocationStore.revokeAgentTokens(
      "agent-expired-line",
      200,
      nowMs + 10_000,
    );
    await expect(
      revocationStore.getAgentRevokedBefore("agent-expired-line"),
    ).resolves.toBe(200);
  });
});
