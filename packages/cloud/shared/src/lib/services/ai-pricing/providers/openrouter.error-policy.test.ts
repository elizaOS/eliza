/**
 * Error-policy pin for fetchOpenRouterCatalogEntries (#13415). OpenRouter is a
 * low-priority (-1) SUPPLEMENTARY price source folded into the BitRouter catalog
 * fetch; a fetch/parse failure must degrade to an empty contribution (return [])
 * rather than propagate — propagating would 500 the whole BitRouter pricing path
 * over an outage of a mere fallback source. This is a money-path-flagged fallback:
 * the value is intentionally [] on failure. The test locks that the failure is
 * still OBSERVABLE via the structured logger and DISTINCT from a legitimately
 * empty catalog (which does not warn) — without asserting any monetary value.
 * bun:test, global fetch mocked + restored per case; logger.warn spied.
 */
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { logger } from "../../../utils/logger";
import { fetchOpenRouterCatalogEntries } from "./openrouter";

const realFetch = globalThis.fetch;
let warnSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  warnSpy = spyOn(logger, "warn").mockImplementation(() => {});
});

afterEach(() => {
  globalThis.fetch = realFetch;
  warnSpy.mockRestore();
});

test("fetch throw degrades to [] and surfaces observably (never propagates a 500)", async () => {
  globalThis.fetch = (async () => {
    throw new Error("network down");
  }) as typeof fetch;

  // Money-path fallback: OpenRouter outage must NOT throw out of the BitRouter
  // catalog fetch. It returns [] AND logs a warning so the failure is visible.
  const entries = await fetchOpenRouterCatalogEntries();

  expect(entries).toEqual([]);
  expect(warnSpy).toHaveBeenCalledTimes(1);
});

test("non-ok HTTP response degrades to [] and surfaces observably", async () => {
  globalThis.fetch = (async () => new Response("upstream boom", { status: 500 })) as typeof fetch;

  const entries = await fetchOpenRouterCatalogEntries();

  expect(entries).toEqual([]);
  expect(warnSpy).toHaveBeenCalledTimes(1);
});

test("legitimately-empty catalog returns [] WITHOUT a failure warning (distinct from failure)", async () => {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ data: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;

  const entries = await fetchOpenRouterCatalogEntries();

  // Same empty return value as the failure cases, but reached by a SUCCESSFUL
  // fetch — proving empty-by-design stays distinguishable (no warn) from the
  // empty-by-failure degrade above.
  expect(entries).toEqual([]);
  expect(warnSpy).not.toHaveBeenCalled();
});

test("malformed JSON body degrades to [] and surfaces observably", async () => {
  globalThis.fetch = (async () =>
    new Response("not-json", {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;

  const entries = await fetchOpenRouterCatalogEntries();

  expect(entries).toEqual([]);
  expect(warnSpy).toHaveBeenCalledTimes(1);
});
