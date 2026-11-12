import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import type { PricingCacheReadOptions } from "./cache";
import type { PreparedPricingEntry, TokenPricingRates } from "./types";

let cacheOutcome: "miss" | "unavailable" = "miss";
let writes = 0;
let writeGate: Promise<void> | null = null;
let background: Promise<unknown>[] = [];
mock.module("../../cache/client", () => ({
  cache: {
    getWithOutcome: async () => ({ kind: cacheOutcome }),
    setWithOutcome: async () => {
      writes++;
      await writeGate;
      return { kind: "written", backend: "memory" };
    },
  },
}));
mock.module("../../utils/logger", () => ({ logger: { warn() {} } }));
const {
  getCachedFlatPricingEntry,
  getCachedTextPricingRates,
  __clearPersistedPricingCache,
  AiPricingCacheUnavailableError,
} = await import("./cache");
const options = (): PricingCacheReadOptions => ({
  cacheOnly: true,
  executionCtx: {
    waitUntil: (p) => {
      background.push(p);
    },
  },
});
beforeEach(() => {
  __clearPersistedPricingCache();
  cacheOutcome = "miss";
  writes = 0;
  writeGate = null;
  background = [];
});
afterEach(async () => {
  await Promise.allSettled(background);
});

function cases<T>(
  kind: string,
  value: T,
  read: (key: string, loader: () => Promise<T>, options: PricingCacheReadOptions) => Promise<T>,
) {
  test(`${kind}: first legitimate cold request consumes authoritative rates`, async () => {
    let loads = 0;
    expect(
      await read(
        kind,
        async () => {
          loads++;
          return value;
        },
        options(),
      ),
    ).toEqual(value);
    await Promise.all(background);
    expect(loads).toBe(1);
    expect(writes).toBe(1);
    expect(
      await read(
        kind,
        async () => {
          throw Error("hot load must not run");
        },
        options(),
      ),
    ).toEqual(value);
    expect(loads).toBe(1);
    expect(writes).toBe(1);
  });
  test(`${kind}: concurrent cold callers share one load and one persistence`, async () => {
    let resolve!: (v: T) => void;
    let loads = 0;
    const gate = new Promise<T>((r) => {
      resolve = r;
    });
    const loader = () => {
      loads++;
      return gate;
    };
    const results = Promise.all([read(kind, loader, options()), read(kind, loader, options())]);
    void results.catch(() => {});
    await Bun.sleep(0);
    expect(loads).toBe(1);
    resolve(value);
    expect(await results).toEqual([value, value]);
    await Promise.all(background);
    expect(writes).toBe(1);
  });
  test(`${kind}: loader failure remains unavailable with no fabricated rate`, async () => {
    await expect(
      read(
        kind,
        async () => {
          throw Error("canonical store unavailable");
        },
        options(),
      ),
    ).rejects.toBeInstanceOf(AiPricingCacheUnavailableError);
    expect(writes).toBe(0);
  });
  test(`${kind}: a cache outage is served from the authoritative load`, async () => {
    cacheOutcome = "unavailable";
    expect(await read(kind, async () => value, options())).toEqual(value);
  });
  test(`${kind}: missing execution context never starts a cold load`, async () => {
    let loads = 0;
    await expect(
      read(
        kind,
        async () => {
          loads++;
          return value;
        },
        { cacheOnly: true },
      ),
    ).rejects.toBeInstanceOf(AiPricingCacheUnavailableError);
    expect(loads).toBe(0);
  });
}
cases<TokenPricingRates>(
  "text",
  { inputUnitPrice: 0.01, outputUnitPrice: 0.02 },
  (key, loader, opts) =>
    getCachedTextPricingRates(key, { input: true, output: true }, loader, opts),
);
const flat: PreparedPricingEntry = {
  billingSource: "seed",
  provider: "cartesia",
  model: "test",
  productFamily: "tts",
  chargeType: "characters",
  unit: "character",
  unitPrice: 0.001,
  sourceKind: "test",
  sourceUrl: "fixture://canonical",
};
cases<PreparedPricingEntry>("flat", flat, getCachedFlatPricingEntry);
test("invalid canonical prices cannot be used for billing", async () => {
  await expect(
    getCachedFlatPricingEntry("invalid-flat", async () => ({ ...flat, unitPrice: 0 }), options()),
  ).rejects.toBeInstanceOf(AiPricingCacheUnavailableError);
  await expect(
    getCachedTextPricingRates(
      "invalid-text",
      { input: true, output: true },
      async () => ({ inputUnitPrice: null, outputUnitPrice: 0 }),
      options(),
    ),
  ).rejects.toBeInstanceOf(AiPricingCacheUnavailableError);
  expect(writes).toBe(0);
});

test("cold response does not await durable cache persistence", async () => {
  let release!: () => void;
  writeGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    const result = await Promise.race([
      getCachedFlatPricingEntry("slow-write", async () => flat, options()),
      Bun.sleep(100).then(() => "response blocked on persistence"),
    ]);
    expect(result).toEqual(flat);
    expect(writes).toBe(1);
    let persisted = false;
    void Promise.all(background).then(() => {
      persisted = true;
    });
    await Bun.sleep(0);
    expect(persisted).toBe(false);
  } finally {
    release();
    await Promise.all(background);
  }
});
