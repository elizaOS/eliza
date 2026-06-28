/**
 * BitRouter price units: the catalog stores per-token unit prices, but
 * BitRouter exposes per-MILLION-token prices under the structured
 * `input_tokens.no_cache` / `output_tokens.text` fields (while the legacy flat
 * `prompt` / `completion` fields are already per-token). The ingest must divide
 * the structured form by 1e6, otherwise every cost is inflated ~1,000,000×
 * (the bug that made claude-sonnet reserve ~$88k for a tiny request while the
 * far-cheaper gpt-oss models slipped under the balance check).
 */

import { describe, expect, test } from "bun:test";
import { buildBitRouterPreparedEntries } from "@/lib/services/ai-pricing";

function priceFor(
  entries: ReturnType<typeof buildBitRouterPreparedEntries>,
  modelId: string,
  chargeType: "input" | "output",
): number | undefined {
  return entries.find((e) => e.model === modelId && e.chargeType === chargeType)?.unitPrice;
}

describe("BitRouter pricing units", () => {
  test("structured per-million prices are normalized to per-token", () => {
    // claude-sonnet-4.5 live catalog: input $3 / 1M, output $15 / 1M.
    const entries = buildBitRouterPreparedEntries({
      id: "anthropic/claude-sonnet-4.5",
      pricing: { input_tokens: { no_cache: 3 }, output_tokens: { text: 15 } },
    } as never);

    expect(priceFor(entries, "anthropic/claude-sonnet-4.5", "input")).toBeCloseTo(0.000003, 12);
    expect(priceFor(entries, "anthropic/claude-sonnet-4.5", "output")).toBeCloseTo(0.000015, 12);
  });

  test("a 1k-token request costs cents, not thousands of dollars", () => {
    const entries = buildBitRouterPreparedEntries({
      id: "anthropic/claude-sonnet-4.5",
      pricing: { input_tokens: { no_cache: 3 }, output_tokens: { text: 15 } },
    } as never);

    const input = priceFor(entries, "anthropic/claude-sonnet-4.5", "input") ?? 0;
    const output = priceFor(entries, "anthropic/claude-sonnet-4.5", "output") ?? 0;
    // 1k input + 1k output tokens
    const cost = input * 1000 + output * 1000;
    expect(cost).toBeCloseTo(0.018, 6); // $0.018, not $18,000
    expect(cost).toBeLessThan(1);
  });

  test("cheap models normalize too (gpt-oss-120b)", () => {
    const entries = buildBitRouterPreparedEntries({
      id: "openai/gpt-oss-120b",
      pricing: { input_tokens: { no_cache: 0.039 }, output_tokens: { text: 0.19 } },
    } as never);

    expect(priceFor(entries, "openai/gpt-oss-120b", "input")).toBeCloseTo(0.000000039, 15);
    expect(priceFor(entries, "openai/gpt-oss-120b", "output")).toBeCloseTo(0.00000019, 15);
  });

  test("legacy flat per-token fields (OpenRouter form) are used as-is", () => {
    const entries = buildBitRouterPreparedEntries({
      id: "legacy/model",
      pricing: { prompt: "0.000003", completion: "0.000015" },
    } as never);

    expect(priceFor(entries, "legacy/model", "input")).toBeCloseTo(0.000003, 12);
    expect(priceFor(entries, "legacy/model", "output")).toBeCloseTo(0.000015, 12);
  });

  test("flat field wins over structured when both are present", () => {
    const entries = buildBitRouterPreparedEntries({
      id: "both/model",
      pricing: {
        prompt: "0.000002",
        input_tokens: { no_cache: 3 },
      },
    } as never);

    expect(priceFor(entries, "both/model", "input")).toBeCloseTo(0.000002, 12);
  });

  test("models without pricing produce no entries", () => {
    const entries = buildBitRouterPreparedEntries({ id: "no/pricing", pricing: {} } as never);
    expect(entries).toHaveLength(0);
  });
});
