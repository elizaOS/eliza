/**
 * Deterministic unit coverage of the cloud e2e seedModelPricing helper.
 * Drives the real seeder and captures the payload it hands to
 * aiPricingRepository.createMany: always one input row then one output row,
 * with observed defaults, overrides, String() unit prices, and a shared
 * effective_from stamped one day in the past. The helper has no queue,
 * comparator, capacity, or item-removal API.
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import * as seedPricing from "./seed-pricing";
import { seedModelPricing } from "./seed-pricing";

type SeededPricingRow = {
  billing_source: string;
  provider: string;
  model: string;
  product_family: "language";
  unit: "tokens";
  currency: "USD";
  dimension_key: "*";
  dimensions: Record<string, never>;
  source_kind: "manual";
  source_url: string;
  is_active: boolean;
  effective_from: Date;
  charge_type: string;
  unit_price: string;
};

const { createMany } = vi.hoisted(() => ({
  createMany: vi.fn<
    (entries: SeededPricingRow[]) => Promise<SeededPricingRow[]>
  >(async (entries) => entries),
}));

vi.mock("@elizaos/cloud-shared/db/repositories/ai-pricing", () => ({
  aiPricingRepository: {
    createMany,
  },
}));

const DAY_MS = 86_400_000;
const DEFAULT_INPUT_PER_TOKEN = 0.00000015;
const DEFAULT_OUTPUT_PER_TOKEN = 0.0000006;

function lastBatch(): SeededPricingRow[] {
  expect(createMany).toHaveBeenCalledTimes(1);
  const batch = createMany.mock.calls[0]?.[0];
  if (batch === undefined) {
    throw new Error("createMany was not called with a row batch");
  }
  return batch;
}

afterEach(() => {
  createMany.mockClear();
  vi.useRealTimers();
});

describe("seedModelPricing exports", () => {
  test("exports only seedModelPricing", () => {
    expect(Object.keys(seedPricing)).toEqual(["seedModelPricing"]);
    expect(seedPricing.seedModelPricing).toBe(seedModelPricing);
  });

  test("does not expose queue, comparator, capacity, or item-removal fields", () => {
    const record = seedPricing as unknown as Record<string, unknown>;
    expect("queue" in record).toBe(false);
    expect("capacity" in record).toBe(false);
    expect("comparator" in record).toBe(false);
    expect("remove" in record).toBe(false);
    expect(record.queue).toBeUndefined();
    expect(record.capacity).toBeUndefined();
    expect(record.comparator).toBeUndefined();
  });
});

describe("seedModelPricing", () => {
  test("writes exactly one input row and one output row in that order", async () => {
    await seedModelPricing({ model: "openai/gpt-4o-mini" });
    const batch = lastBatch();
    expect(batch).toHaveLength(2);
    expect(batch[0]?.charge_type).toBe("input");
    expect(batch[1]?.charge_type).toBe("output");
  });

  test("returns undefined (Promise<void>) even when createMany returns the rows", async () => {
    await expect(
      seedModelPricing({ model: "openai/gpt-4o-mini" }),
    ).resolves.toBeUndefined();
  });

  test("applies openai defaults and the test source URL when optionals are omitted", async () => {
    await seedModelPricing({ model: "openai/gpt-4o-mini" });
    const [input, output] = lastBatch();
    expect(input).toMatchObject({
      billing_source: "openai",
      provider: "openai",
      model: "openai/gpt-4o-mini",
      product_family: "language",
      unit: "tokens",
      currency: "USD",
      dimension_key: "*",
      dimensions: {},
      source_kind: "manual",
      source_url: "test://seed-pricing",
      is_active: true,
      charge_type: "input",
      unit_price: String(DEFAULT_INPUT_PER_TOKEN),
    });
    expect(output).toMatchObject({
      billing_source: "openai",
      provider: "openai",
      model: "openai/gpt-4o-mini",
      charge_type: "output",
      unit_price: String(DEFAULT_OUTPUT_PER_TOKEN),
    });
  });

  test("String() of the default per-token rates is scientific notation, not a padded decimal", async () => {
    await seedModelPricing({ model: "m" });
    const [input, output] = lastBatch();
    expect(input?.unit_price).toBe("1.5e-7");
    expect(output?.unit_price).toBe("6e-7");
    expect(input?.unit_price).not.toBe("0.00000015");
    expect(output?.unit_price).not.toBe("0.0000006");
  });

  test("overrides billingSource and provider independently", async () => {
    await seedModelPricing({
      model: "openai/gpt-4o-mini",
      billingSource: "bitrouter",
      provider: "openai",
    });
    const batch = lastBatch();
    for (const row of batch) {
      expect(row.billing_source).toBe("bitrouter");
      expect(row.provider).toBe("openai");
      expect(row.model).toBe("openai/gpt-4o-mini");
    }
  });

  test("String()s custom per-token rates onto the matching charge_type row", async () => {
    await seedModelPricing({
      model: "custom-model",
      inputPerToken: 0.002,
      outputPerToken: 0.004,
    });
    const [input, output] = lastBatch();
    expect(input?.unit_price).toBe("0.002");
    expect(output?.unit_price).toBe("0.004");
  });

  test("treats explicit 0 as a price, not as a missing optional (?? not ||)", async () => {
    await seedModelPricing({
      model: "zero-model",
      inputPerToken: 0,
      outputPerToken: 0,
    });
    const [input, output] = lastBatch();
    expect(input?.unit_price).toBe("0");
    expect(output?.unit_price).toBe("0");
  });

  test("treats explicit undefined optionals as missing and applies defaults", async () => {
    await seedModelPricing({
      model: "undef-model",
      inputPerToken: undefined,
      outputPerToken: undefined,
      billingSource: undefined,
      provider: undefined,
    });
    const [input, output] = lastBatch();
    expect(input?.billing_source).toBe("openai");
    expect(input?.provider).toBe("openai");
    expect(input?.unit_price).toBe(String(DEFAULT_INPUT_PER_TOKEN));
    expect(output?.unit_price).toBe(String(DEFAULT_OUTPUT_PER_TOKEN));
  });

  test("passes an empty model string through rather than substituting a default", async () => {
    await seedModelPricing({ model: "" });
    const batch = lastBatch();
    expect(batch[0]?.model).toBe("");
    expect(batch[1]?.model).toBe("");
  });

  test("stamps a shared effective_from exactly one day behind Date.now()", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-23T12:00:00.000Z"));
    const expected = new Date(
      new Date("2026-08-23T12:00:00.000Z").getTime() - DAY_MS,
    );
    await seedModelPricing({ model: "timed" });
    const [input, output] = lastBatch();
    expect(input?.effective_from).toEqual(expected);
    expect(output?.effective_from).toEqual(expected);
    expect(output?.effective_from).toBe(input?.effective_from);
  });

  test("does not grow or shrink the batch (no capacity or overflow behaviour)", async () => {
    await seedModelPricing({
      model: "overflow",
      inputPerToken: Number.MAX_VALUE,
      outputPerToken: Number.MIN_VALUE,
    });
    const batch = lastBatch();
    expect(batch).toHaveLength(2);
    expect(batch[0]?.unit_price).toBe(String(Number.MAX_VALUE));
    expect(batch[1]?.unit_price).toBe(String(Number.MIN_VALUE));
  });

  test("propagates a createMany rejection and does not swallow it", async () => {
    const failure = new Error("insert failed");
    createMany.mockRejectedValueOnce(failure);
    await expect(seedModelPricing({ model: "failing" })).rejects.toBe(failure);
    expect(createMany).toHaveBeenCalledTimes(1);
  });

  test("String()s NaN and Infinity rather than substituting the default rates", async () => {
    await seedModelPricing({
      model: "nonfinite",
      inputPerToken: Number.NaN,
      outputPerToken: Number.POSITIVE_INFINITY,
    });
    const [input, output] = lastBatch();
    expect(input?.unit_price).toBe("NaN");
    expect(output?.unit_price).toBe("Infinity");
  });
});
