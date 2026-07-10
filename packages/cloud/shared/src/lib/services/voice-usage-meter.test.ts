import { describe, expect, test } from "bun:test";
import {
  type AtomicVoiceUsageRedis,
  checkVoiceByteRate,
  createDurableVoiceUsageStore,
  InMemoryVoiceUsageStore,
  pcmDurationMinutes,
  RedisVoiceUsageStore,
} from "./voice-usage-meter";

describe("InMemoryVoiceUsageStore", () => {
  test("isolates organization and user daily counters", async () => {
    const store = new InMemoryVoiceUsageStore(() => Date.UTC(2026, 6, 10));
    const limits = { organizationDailyMinutes: 10, userDailyMinutes: 6 };

    expect(
      (await store.checkAndRecord({ organizationId: "a", userId: "u1" }, 4, limits)).allowed,
    ).toBe(true);
    expect(
      await store.checkAndRecord({ organizationId: "a", userId: "u1" }, 3, limits),
    ).toMatchObject({ allowed: false, scope: "user" });
    expect(
      (await store.checkAndRecord({ organizationId: "a", userId: "u2" }, 6, limits)).allowed,
    ).toBe(true);
    expect(
      await store.checkAndRecord({ organizationId: "a", userId: "u3" }, 1, limits),
    ).toMatchObject({ allowed: false, scope: "organization" });
    expect(
      (await store.checkAndRecord({ organizationId: "b", userId: "u1" }, 6, limits)).allowed,
    ).toBe(true);
  });

  test("releases a failed-operation reservation", async () => {
    const store = new InMemoryVoiceUsageStore(() => Date.UTC(2026, 6, 10));
    const identity = { organizationId: "a", userId: "u" };
    const limits = { organizationDailyMinutes: 5, userDailyMinutes: 5 };
    expect((await store.checkAndRecord(identity, 5, limits)).allowed).toBe(true);
    await store.release(identity, 3);
    expect((await store.checkAndRecord(identity, 3, limits)).allowed).toBe(true);
  });

  test("resets counters at the UTC day boundary", async () => {
    let now = Date.UTC(2026, 6, 10, 23, 59);
    const store = new InMemoryVoiceUsageStore(() => now);
    const identity = { organizationId: "a", userId: "u" };
    const limits = { organizationDailyMinutes: 2, userDailyMinutes: 2 };
    expect((await store.checkAndRecord(identity, 2, limits)).allowed).toBe(true);
    expect((await store.checkAndRecord(identity, 0.1, limits)).allowed).toBe(false);
    now = Date.UTC(2026, 6, 11);
    expect(await store.checkAndRecord(identity, 2, limits)).toMatchObject({
      allowed: true,
      day: "2026-07-11",
    });
  });
});

describe("RedisVoiceUsageStore", () => {
  test("does not misclassify the non-Lua mock client as durable", () => {
    expect(createDurableVoiceUsageStore({ MOCK_REDIS: "1" })).toBeNull();
  });

  test("uses one atomic script with day-scoped org and user keys", async () => {
    const calls: Array<{ keys: string[]; args: Array<string | number> }> = [];
    const redis: AtomicVoiceUsageRedis = {
      async eval(_script, keys, args) {
        calls.push({ keys, args });
        return [1, 0, 2_000_000, 1_000_000];
      },
    };
    const store = new RedisVoiceUsageStore(redis, () => Date.UTC(2026, 6, 10, 12));
    const decision = await store.checkAndRecord({ organizationId: "org", userId: "user" }, 1, {
      organizationDailyMinutes: 10,
      userDailyMinutes: 5,
    });

    expect(decision).toMatchObject({
      allowed: true,
      organizationUsedMinutes: 2,
      userUsedMinutes: 1,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].keys).toEqual([
      "voice-usage:2026-07-10:org:org",
      "voice-usage:2026-07-10:user:org:user",
    ]);
    expect(calls[0].args.slice(0, 3)).toEqual([1_000_000, 10_000_000, 5_000_000]);

    await store.release({ organizationId: "org", userId: "user" }, 1);
    expect(calls).toHaveLength(2);
    expect(calls[1].keys).toEqual(calls[0].keys);
    expect(calls[1].args[0]).toBe(1_000_000);
  });

  test("maps an atomic user denial without recording partial usage", async () => {
    const redis: AtomicVoiceUsageRedis = {
      async eval() {
        return [0, 2, 4_000_000, 4_500_000];
      },
    };
    const decision = await new RedisVoiceUsageStore(redis, () =>
      Date.UTC(2026, 6, 10),
    ).checkAndRecord({ organizationId: "org", userId: "user" }, 1, {
      organizationDailyMinutes: 10,
      userDailyMinutes: 5,
    });
    expect(decision).toMatchObject({ allowed: false, scope: "user", usedMinutes: 4.5 });
  });
});

describe("voice byte and duration accounting", () => {
  test("enforces a server-observed byte-rate ceiling with jitter grace", () => {
    expect(
      checkVoiceByteRate({ observedBytes: 48_000, elapsedMs: 1_000, maxBytesPerSecond: 32_000 }),
    ).toMatchObject({ allowed: true, allowedBytes: 64_000 });
    expect(
      checkVoiceByteRate({ observedBytes: 64_001, elapsedMs: 1_000, maxBytesPerSecond: 32_000 })
        .allowed,
    ).toBe(false);
  });

  test("derives PCM minutes from server-observed bytes and format", () => {
    expect(
      pcmDurationMinutes({
        byteLength: 1_920_000,
        sampleRate: 16_000,
        channels: 1,
        bytesPerSample: 2,
      }),
    ).toBe(1);
  });
});
