/**
 * Pins the OpenRouter pricing fallback that reconciles the catalog: any language
 * model the API offers that BitRouter's catalog does not price (e.g.
 * openai/gpt-5.5, anthropic/claude-haiku-4.5, x-ai/grok-4.20) gets a real
 * per-token price from OpenRouter's public catalog instead of 500-ing
 * "Pricing unavailable". Entries are low-priority (-1) so live BitRouter rows and
 * forced rows always win.
 */
import { expect, test } from "bun:test";
import {
  buildOpenRouterPreparedEntries,
  fetchOpenRouterCatalogEntries,
} from "./providers/openrouter";
import type { BitRouterCatalogModel } from "./types";

const model = (id: string, pricing: Record<string, unknown>): BitRouterCatalogModel =>
  ({ id, pricing }) as BitRouterCatalogModel;

test("maps a language model's prices to per-token input/output fallback rows", () => {
  const entries = buildOpenRouterPreparedEntries(
    model("openai/gpt-5.5", { prompt: "0.000005", completion: "0.00003" }),
  );
  expect(entries.length).toBe(2);

  const input = entries.find((e) => e.chargeType === "input");
  expect(input?.unitPrice).toBe(0.000005);
  expect(input?.productFamily).toBe("language");
  expect(input?.unit).toBe("token");
  expect(input?.provider).toBe("openai");
  expect(input?.billingSource).toBe("bitrouter");
  expect(input?.priority).toBe(-1); // fallback — live/forced rows win

  expect(entries.find((e) => e.chargeType === "output")?.unitPrice).toBe(0.00003);
});

test("excludes non-language models and unpriced models", () => {
  expect(
    buildOpenRouterPreparedEntries(
      model("google/gemini-3.1-flash-image-preview", { prompt: "0.0000005" }),
    ),
  ).toEqual([]);
  expect(
    buildOpenRouterPreparedEntries(
      model("openai/text-embedding-3-small", { prompt: "0.00000002" }),
    ),
  ).toEqual([]);
  expect(buildOpenRouterPreparedEntries(model("openai/gpt-5.5", {}))).toEqual([]);
});

test("fetchOpenRouterCatalogEntries parses a catalog payload (fetch mocked)", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        data: [
          {
            id: "anthropic/claude-haiku-4.5",
            pricing: { prompt: "0.000001", completion: "0.000005" },
          },
          { id: "x-ai/grok-4.20", pricing: { prompt: "0.00000125", completion: "0.0000025" } },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    )) as typeof fetch;
  try {
    const entries = await fetchOpenRouterCatalogEntries();
    const haikuInput = entries.find(
      (e) => e.model === "anthropic/claude-haiku-4.5" && e.chargeType === "input",
    );
    expect(haikuInput?.unitPrice).toBe(0.000001);
    expect(
      entries.some(
        (e) =>
          e.model === "x-ai/grok-4.20" && e.chargeType === "output" && e.unitPrice === 0.0000025,
      ),
    ).toBe(true);
  } finally {
    globalThis.fetch = original;
  }
});

test("fetchOpenRouterCatalogEntries is non-fatal when OpenRouter is unreachable", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error("network down");
  }) as typeof fetch;
  try {
    expect(await fetchOpenRouterCatalogEntries()).toEqual([]);
  } finally {
    globalThis.fetch = original;
  }
});
