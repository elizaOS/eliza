/**
 * Pricing cache tests drive real coalescing, validation, and Worker cold-miss
 * behavior behind injected authoritative loaders and durable-cache spies.
 * They prove that dependency failures remain distinct from empty results and
 * that admission never waits for or reads back a background persistence write.
 */
import { afterEach, expect, mock, spyOn, test } from "bun:test";
import type { AiPricingEntry } from "../../../db/schemas/ai-pricing";
import { cache } from "../../cache/client";
import { logger } from "../../utils/logger";
import {
  __clearPersistedPricingCache,
  AiPricingCacheUnavailableError,
  getCachedExternalEntries,
  getCachedFlatPricingEntry,
  getCachedPersistedEntries,
  getCachedTextPricingRates,
} from "./cache";
import type { PreparedPricingEntry } from "./types";

const TOKEN_RATES = {
  inputUnitPrice: 0.000001,
  outputUnitPrice: 0.000004,
};

const FLAT_ENTRY = {
  billingSource: "fal",
  provider: "fal",
  model: "fal-ai/test",
  productFamily: "image",
  chargeType: "generation",
  unit: "image",
  unitPrice: 0.01,
} as PreparedPricingEntry;

function workerOptions(background: Promise<unknown>[], coldHydrationDeadlineMs = 1_000) {
  return {
    cacheOnly: true,
    coldHydrationDeadlineMs,
    executionCtx: {
      waitUntil: (promise: Promise<unknown>) => background.push(promise),
    },
  };
}

function stubColdDurableCache() {
  const read = spyOn(cache, "getWithOutcome").mockResolvedValue({
    kind: "miss",
    backend: "memory",
  });
  const write = spyOn(cache, "setWithOutcome").mockResolvedValue({
    kind: "written",
    backend: "memory",
  });
  return { read, write };
}

afterEach(() => {
  __clearPersistedPricingCache();
  mock.restore();
});

test("negative-caches a failing loader — subsequent lookups skip the re-fetch", async () => {
  let calls = 0;
  const loader = async (): Promise<PreparedPricingEntry[]> => {
    calls++;
    throw new Error("upstream 404");
  };

  // First call: the failure propagates so the caller degrades to seed/cached
  // pricing (unchanged behavior); the loader is invoked exactly once.
  await expect(getCachedExternalEntries("test:neg", loader)).rejects.toThrow("upstream 404");
  expect(calls).toBe(1);

  // Subsequent call within the negative TTL: returns the cached empty result
  // WITHOUT re-invoking the (slow, failing) loader.
  const second = await getCachedExternalEntries("test:neg", loader);
  expect(second).toEqual([]);
  expect(calls).toBe(1);
});

test("caches a successful loader result — loader runs once", async () => {
  let calls = 0;
  const entry = {
    model: "m",
    provider: "p",
  } as unknown as PreparedPricingEntry;
  const loader = async (): Promise<PreparedPricingEntry[]> => {
    calls++;
    return [entry];
  };

  expect(await getCachedExternalEntries("test:pos", loader)).toEqual([entry]);
  expect(await getCachedExternalEntries("test:pos", loader)).toEqual([entry]);
  expect(calls).toBe(1);
});

test("persisted: caches a successful DB read — loader runs once within TTL", async () => {
  __clearPersistedPricingCache();
  let calls = 0;
  const row = {
    model: "gpt-oss-120b",
    provider: "cerebras",
  } as unknown as AiPricingEntry;
  const loader = async (): Promise<AiPricingEntry[]> => {
    calls++;
    return [row];
  };
  expect(await getCachedPersistedEntries("k1", loader)).toEqual([row]);
  expect(await getCachedPersistedEntries("k1", loader)).toEqual([row]);
  expect(calls).toBe(1);
});

test("persisted: does NOT negative-cache a DB error — the next call retries", async () => {
  __clearPersistedPricingCache();
  let calls = 0;
  const loader = async (): Promise<AiPricingEntry[]> => {
    calls++;
    throw new Error("db transient");
  };
  // Unlike the external catalog (permanent 404 → negative-cache), a DB error is
  // transient and must re-run on the next request.
  await expect(getCachedPersistedEntries("k2", loader)).rejects.toThrow("db transient");
  await expect(getCachedPersistedEntries("k2", loader)).rejects.toThrow("db transient");
  expect(calls).toBe(2);
});

test("persisted: distinct keys cache independently (no cross-key bleed)", async () => {
  __clearPersistedPricingCache();
  const a = { model: "a" } as unknown as AiPricingEntry;
  const b = { model: "b" } as unknown as AiPricingEntry;
  expect(await getCachedPersistedEntries("ka", async () => [a])).toEqual([a]);
  expect(await getCachedPersistedEntries("kb", async () => [b])).toEqual([b]);
  // 'ka' stays cached as [a] even though this loader would return [b].
  expect(await getCachedPersistedEntries("ka", async () => [b])).toEqual([a]);
});

test("persisted: concurrent cold misses for the same key coalesce onto one read (#16162)", async () => {
  __clearPersistedPricingCache();
  const row = { model: "m" } as unknown as AiPricingEntry;
  let calls = 0;
  const gate = Promise.withResolvers<AiPricingEntry[]>();
  const loader = (): Promise<AiPricingEntry[]> => {
    calls++;
    return gate.promise;
  };

  // Both fired before either resolves — the hot-path shape lookup.ts produces.
  const p1 = getCachedPersistedEntries("cc", loader);
  const p2 = getCachedPersistedEntries("cc", loader);
  gate.resolve([row]);

  expect(await p1).toEqual([row]);
  expect(await p2).toEqual([row]);
  expect(calls).toBe(1); // one shared read, not two duplicate DB round-trips
});

test("external: concurrent cold misses for the same key coalesce onto one read (#16162)", async () => {
  const entry = {
    model: "m",
    provider: "p",
  } as unknown as PreparedPricingEntry;
  let calls = 0;
  const gate = Promise.withResolvers<PreparedPricingEntry[]>();
  const loader = (): Promise<PreparedPricingEntry[]> => {
    calls++;
    return gate.promise;
  };

  const p1 = getCachedExternalEntries("cc:ext", loader);
  const p2 = getCachedExternalEntries("cc:ext", loader);
  gate.resolve([entry]);

  expect(await p1).toEqual([entry]);
  expect(await p2).toEqual([entry]);
  expect(calls).toBe(1);
});

test("persisted: concurrent rejection is shared and a later request retries", async () => {
  __clearPersistedPricingCache();
  const gate = Promise.withResolvers<AiPricingEntry[]>();
  let calls = 0;
  const loader = (): Promise<AiPricingEntry[]> => {
    calls++;
    return gate.promise;
  };

  const first = getCachedPersistedEntries("reject", loader);
  const concurrent = getCachedPersistedEntries("reject", loader);
  const settled = Promise.allSettled([first, concurrent]);
  gate.reject(new Error("db transient"));

  const results = await settled;
  expect(results.map((result) => result.status)).toEqual(["rejected", "rejected"]);
  for (const result of results) {
    if (result.status !== "rejected") throw new Error("expected rejection");
    if (!(result.reason instanceof Error)) throw new Error("expected Error reason");
    expect(result.reason.message).toBe("db transient");
  }
  expect(calls).toBe(1);
  await expect(getCachedPersistedEntries("reject", async () => [])).resolves.toEqual([]);
});

test("cache-only token pricing without a Worker lifetime is explicitly unavailable", async () => {
  __clearPersistedPricingCache();
  const loader = mock(async () => ({
    inputUnitPrice: 0.000001,
    outputUnitPrice: 0.000004,
  }));

  await expect(
    getCachedTextPricingRates("worker-lifetime-required", { input: true, output: true }, loader, {
      cacheOnly: true,
    }),
  ).rejects.toBeInstanceOf(AiPricingCacheUnavailableError);
  expect(loader).not.toHaveBeenCalled();
});

test("cold token pricing consumes one authoritative hydration while KV persistence stays background", async () => {
  __clearPersistedPricingCache();
  const { read, write } = stubColdDurableCache();
  const writeGate = Promise.withResolvers<{
    kind: "written";
    backend: "memory";
  }>();
  write.mockImplementation(() => writeGate.promise);
  const loader = mock(async () => TOKEN_RATES);
  const background: Promise<unknown>[] = [];

  await expect(
    getCachedTextPricingRates(
      "token-cold-success",
      { input: true, output: true },
      loader,
      workerOptions(background),
    ),
  ).resolves.toEqual(TOKEN_RATES);
  expect(background).toHaveLength(1);
  expect(write).toHaveBeenCalledTimes(1);
  writeGate.resolve({ kind: "written", backend: "memory" });
  await Promise.all(background);
  expect(read).toHaveBeenCalledTimes(1);
  expect(loader).toHaveBeenCalledTimes(1);
  expect(write).toHaveBeenCalledTimes(1);
});

test("concurrent token cold misses share one authoritative load and one background write", async () => {
  __clearPersistedPricingCache();
  const { read, write } = stubColdDurableCache();
  const gate = Promise.withResolvers<typeof TOKEN_RATES>();
  const loader = mock(() => gate.promise);
  const background: Promise<unknown>[] = [];
  const options = workerOptions(background);

  const first = getCachedTextPricingRates(
    "token-cold-concurrent",
    { input: true, output: true },
    loader,
    options,
  );
  const second = getCachedTextPricingRates(
    "token-cold-concurrent",
    { input: true, output: true },
    loader,
    options,
  );
  gate.resolve(TOKEN_RATES);

  await expect(Promise.all([first, second])).resolves.toEqual([TOKEN_RATES, TOKEN_RATES]);
  await Promise.all(background);
  expect(read).toHaveBeenCalledTimes(2);
  expect(loader).toHaveBeenCalledTimes(1);
  expect(write).toHaveBeenCalledTimes(1);
});

test("rejected token hydration fails closed with sanitized telemetry", async () => {
  __clearPersistedPricingCache();
  const { write } = stubColdDurableCache();
  const warn = spyOn(logger, "warn").mockImplementation(() => undefined);
  const loader = mock(async () => {
    throw new Error("secret-account-123 database rejected");
  });
  const background: Promise<unknown>[] = [];

  await expect(
    getCachedTextPricingRates(
      "secret-model-key",
      { input: true, output: true },
      loader,
      workerOptions(background),
    ),
  ).rejects.toBeInstanceOf(AiPricingCacheUnavailableError);
  await Promise.all(background);
  expect(write).not.toHaveBeenCalled();
  const telemetry = JSON.stringify(warn.mock.calls);
  expect(telemetry).not.toContain("secret-account-123");
  expect(telemetry).not.toContain("secret-model-key");
});

test("invalid token hydration fails closed without a durable write", async () => {
  __clearPersistedPricingCache();
  const { write } = stubColdDurableCache();
  const background: Promise<unknown>[] = [];

  await expect(
    getCachedTextPricingRates(
      "token-cold-invalid",
      { input: true, output: true },
      async () => ({ inputUnitPrice: TOKEN_RATES.inputUnitPrice, outputUnitPrice: null }),
      workerOptions(background),
    ),
  ).rejects.toBeInstanceOf(AiPricingCacheUnavailableError);
  await Promise.all(background);
  expect(write).not.toHaveBeenCalled();
});

test("timed-out token hydration fails closed, then finishes its background write without readback", async () => {
  __clearPersistedPricingCache();
  const { read, write } = stubColdDurableCache();
  const gate = Promise.withResolvers<typeof TOKEN_RATES>();
  const loader = mock(() => gate.promise);
  const background: Promise<unknown>[] = [];
  const options = workerOptions(background, 5);

  await expect(
    getCachedTextPricingRates("token-cold-timeout", { input: true, output: true }, loader, options),
  ).rejects.toBeInstanceOf(AiPricingCacheUnavailableError);
  expect(read).toHaveBeenCalledTimes(1);
  gate.resolve(TOKEN_RATES);
  await Promise.all(background);
  expect(write).toHaveBeenCalledTimes(1);
  await expect(
    getCachedTextPricingRates("token-cold-timeout", { input: true, output: true }, loader, options),
  ).resolves.toEqual(TOKEN_RATES);
  expect(read).toHaveBeenCalledTimes(1);
});

test("cold flat pricing consumes one authoritative hydration while KV persistence stays background", async () => {
  __clearPersistedPricingCache();
  const { read, write } = stubColdDurableCache();
  const writeGate = Promise.withResolvers<{
    kind: "written";
    backend: "memory";
  }>();
  write.mockImplementation(() => writeGate.promise);
  const loader = mock(async () => FLAT_ENTRY);
  const background: Promise<unknown>[] = [];

  await expect(
    getCachedFlatPricingEntry("flat-cold-success", loader, workerOptions(background)),
  ).resolves.toEqual(FLAT_ENTRY);
  expect(write).toHaveBeenCalledTimes(1);
  writeGate.resolve({ kind: "written", backend: "memory" });
  await Promise.all(background);
  expect(read).toHaveBeenCalledTimes(1);
  expect(loader).toHaveBeenCalledTimes(1);
  expect(write).toHaveBeenCalledTimes(1);
});

test("concurrent flat cold misses share one authoritative load and one background write", async () => {
  __clearPersistedPricingCache();
  const { read, write } = stubColdDurableCache();
  const gate = Promise.withResolvers<PreparedPricingEntry>();
  const loader = mock(() => gate.promise);
  const background: Promise<unknown>[] = [];
  const options = workerOptions(background);

  const first = getCachedFlatPricingEntry("flat-cold-concurrent", loader, options);
  const second = getCachedFlatPricingEntry("flat-cold-concurrent", loader, options);
  gate.resolve(FLAT_ENTRY);

  await expect(Promise.all([first, second])).resolves.toEqual([FLAT_ENTRY, FLAT_ENTRY]);
  await Promise.all(background);
  expect(read).toHaveBeenCalledTimes(2);
  expect(loader).toHaveBeenCalledTimes(1);
  expect(write).toHaveBeenCalledTimes(1);
});

test("rejected or invalid flat hydration fails closed without a durable write", async () => {
  __clearPersistedPricingCache();
  const { write } = stubColdDurableCache();
  const rejectedBackground: Promise<unknown>[] = [];
  await expect(
    getCachedFlatPricingEntry(
      "flat-cold-rejected",
      async () => {
        throw new Error("catalog dependency rejected");
      },
      workerOptions(rejectedBackground),
    ),
  ).rejects.toBeInstanceOf(AiPricingCacheUnavailableError);
  await Promise.all(rejectedBackground);

  __clearPersistedPricingCache();
  const invalidBackground: Promise<unknown>[] = [];
  await expect(
    getCachedFlatPricingEntry(
      "flat-cold-invalid",
      async () => ({ ...FLAT_ENTRY, unitPrice: -1 }),
      workerOptions(invalidBackground),
    ),
  ).rejects.toBeInstanceOf(AiPricingCacheUnavailableError);
  await Promise.all(invalidBackground);
  expect(write).not.toHaveBeenCalled();
});

test("flat pricing rejects non-finite durable timestamps instead of serving them forever", async () => {
  for (const [label, cachedAt] of [
    ["infinity", Number.POSITIVE_INFINITY],
    ["nan", Number.NaN],
  ] as const) {
    __clearPersistedPricingCache();
    const read = spyOn(cache, "getWithOutcome").mockResolvedValueOnce({
      kind: "hit",
      backend: "memory",
      value: { v: 1, cachedAt, entry: FLAT_ENTRY },
    });
    const write = spyOn(cache, "setWithOutcome").mockResolvedValue({
      kind: "written",
      backend: "memory",
    });
    const loader = mock(async () => FLAT_ENTRY);
    const background: Promise<unknown>[] = [];

    await expect(
      getCachedFlatPricingEntry(
        `flat-corrupt-timestamp-${label}`,
        loader,
        workerOptions(background),
      ),
    ).rejects.toBeInstanceOf(AiPricingCacheUnavailableError);
    await Promise.all(background);
    expect(read).toHaveBeenCalledTimes(1);
    expect(loader).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledTimes(1);
    mock.restore();
  }
});

test("timed-out flat hydration fails closed, then finishes its background write without readback", async () => {
  __clearPersistedPricingCache();
  const { read, write } = stubColdDurableCache();
  const gate = Promise.withResolvers<PreparedPricingEntry>();
  const loader = mock(() => gate.promise);
  const background: Promise<unknown>[] = [];
  const options = workerOptions(background, 5);

  await expect(
    getCachedFlatPricingEntry("flat-cold-timeout", loader, options),
  ).rejects.toBeInstanceOf(AiPricingCacheUnavailableError);
  expect(read).toHaveBeenCalledTimes(1);
  gate.resolve(FLAT_ENTRY);
  await Promise.all(background);
  expect(write).toHaveBeenCalledTimes(1);
  await expect(getCachedFlatPricingEntry("flat-cold-timeout", loader, options)).resolves.toEqual(
    FLAT_ENTRY,
  );
  expect(read).toHaveBeenCalledTimes(1);
});

test("cache-only flat pricing without a Worker lifetime is explicitly unavailable", async () => {
  __clearPersistedPricingCache();
  const loader = mock(async () => ({}) as PreparedPricingEntry);

  await expect(
    getCachedFlatPricingEntry("flat-worker-lifetime-required", loader, {
      cacheOnly: true,
    }),
  ).rejects.toBeInstanceOf(AiPricingCacheUnavailableError);
  expect(loader).not.toHaveBeenCalled();
});

test("canonical token pricing rejects an incomplete required rate instead of fabricating zero", async () => {
  __clearPersistedPricingCache();

  await expect(
    getCachedTextPricingRates("missing-output-rate", { input: true, output: true }, async () => ({
      inputUnitPrice: 0.000001,
      outputUnitPrice: null,
    })),
  ).rejects.toThrow("invalid or incomplete token rates");
});
