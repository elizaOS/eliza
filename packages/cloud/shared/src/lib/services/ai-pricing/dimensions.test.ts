// Exercises dimensions behavior with deterministic cloud-shared lib fixtures.
import Decimal from "decimal.js";
import { describe, expect, test } from "vitest";
import { PLATFORM_MARKUP_MULTIPLIER } from "../../pricing-constants";
import {
  applyPlatformMarkup,
  asDecimal,
  buildDimensionKey,
  canonicalModelId,
  decimalToMoney,
  dimensionsAreSubset,
  inferProviderFromCanonicalModel,
  normalizePricingDimensions,
  sourcePriorityForKind,
} from "./dimensions";

/**
 * AI-pricing dimension + model-id logic. Markup math (base → total) drives real
 * billing; dimension normalization/keying must be order-independent so cache
 * keys match; and canonical model-id resolution must route a request to the
 * correct provider's price row.
 */

describe("markup math", () => {
  test("decimalToMoney rounds to 6 dp; applyPlatformMarkup adds the platform markup", () => {
    expect(decimalToMoney(new Decimal("1.2345678"))).toBe(1.234568);
    const out = applyPlatformMarkup(new Decimal("10"));
    expect(out.baseTotalCost).toBe(10);
    expect(out.totalCost).toBe(decimalToMoney(asDecimal(10).mul(PLATFORM_MARKUP_MULTIPLIER)));
    expect(out.totalCost).toBeGreaterThan(out.baseTotalCost);
    expect(out.platformMarkup).toBeCloseTo(out.totalCost - out.baseTotalCost, 6);
  });
});

describe("dimensions", () => {
  test("normalize is order-independent and drops undefined; key collapses empty to '*'", () => {
    expect(normalizePricingDimensions({ b: 2, a: 1, c: undefined })).toEqual({
      a: 1,
      b: 2,
    });
    expect(normalizePricingDimensions(undefined)).toEqual({});
    expect(buildDimensionKey({})).toBe("*");
    expect(buildDimensionKey({ a: 1, b: 2 })).toBe(buildDimensionKey({ b: 2, a: 1 }));
  });

  test("subset check + source priority", () => {
    expect(dimensionsAreSubset({ a: 1 }, { a: 1, b: 2 })).toBe(true);
    expect(dimensionsAreSubset({ a: 2 }, { a: 1 })).toBe(false);
    expect(sourcePriorityForKind("manual_override")).toBe(1000);
    expect(sourcePriorityForKind("bitrouter_catalog")).toBe(200);
    expect(sourcePriorityForKind("whatever")).toBe(100);
  });
});

describe("canonical model id", () => {
  test("keeps slashed ids, prepends provider, handles special providers", () => {
    expect(canonicalModelId("openai/gpt-4")).toBe("openai/gpt-4");
    expect(canonicalModelId("gpt-4", "anthropic")).toBe("anthropic/gpt-4");
    expect(canonicalModelId("gpt-4")).toBe("gpt-4");
    expect(canonicalModelId("voice-x", "elevenlabs")).toBe("elevenlabs/voice-x");
  });

  test("inferProviderFromCanonicalModel reads the prefix", () => {
    expect(inferProviderFromCanonicalModel("fal-ai/flux")).toBe("fal");
    expect(inferProviderFromCanonicalModel("elevenlabs/v1")).toBe("elevenlabs");
    expect(inferProviderFromCanonicalModel("cerebras/llama")).toBe("cerebras");
    expect(inferProviderFromCanonicalModel("noslash")).toBe("unknown");
  });
});
