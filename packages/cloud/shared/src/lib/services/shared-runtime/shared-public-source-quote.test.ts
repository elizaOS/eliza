/** Source-bound citation regressions. These synthetic sources contain no owner data. */
import { expect, test } from "bun:test";
import type { SharedRuntimePublicGrounding } from "../../../db/schemas/shared-runtime-history";
import {
  finalizeSharedRealtimeReply,
  normalizeSharedPublicCitations,
  prepareSharedPublicSourceQuoteRepair,
  resolveSharedRealtimeRequirement,
  validateSharedPublicSourceQuoteRepair,
} from "./shared-realtime-grounding";

const now = Date.parse("2026-10-10T10:00:00Z");
const message = "What is Bitcoin trading at in USD right now?";
const source = {
  url: "https://example.com/bitcoin-price",
  text: "The current price of Bitcoin is 84354.17 USD.",
};
const requirement = resolveSharedRealtimeRequirement(message, []);
if (!requirement) throw new Error("Owning current-price request was not classified");
const authorizedQuery = requirement.query;
const grounding: SharedRuntimePublicGrounding = {
  kind: "web_search",
  query: requirement.query,
  provider: "parallel",
  observedAt: now,
  sources: [source],
  sourceUrls: [source.url],
  text: JSON.stringify({ results: [source] }),
  truncated: false,
};
const draft = `Bitcoin is trading at 84354 USD. ${source.url}`;

function request() {
  const value = prepareSharedPublicSourceQuoteRepair(
    message,
    draft,
    grounding,
    now,
    "markets",
    authorizedQuery,
  );
  if (!value) throw new Error("An exact cited current receipt must admit one quote extraction");
  return value;
}

test("natural exact citations preserve factual checks", () => {
  expect(
    normalizeSharedPublicCitations(
      `The price of Bitcoin is 84354.17 USD. [source](${source.url})`,
      grounding,
    ),
  ).toContain(`[[SOURCE_URL:${source.url}]]`);
  const supported = finalizeSharedRealtimeReply(
    `The price of Bitcoin is 84354.17 USD. ${source.url}`,
    grounding,
  );
  expect(supported).toContain("84354.17 USD");
  expect(supported).toContain(source.url);
  expect(supported).not.toContain("[[SOURCE_URL:");
  expect(finalizeSharedRealtimeReply(draft, grounding)).toContain("couldn’t verify");
});

test("one exact current quote repairs the rounded draft", () => {
  const quote = validateSharedPublicSourceQuoteRepair(
    { status: "supported", sourceUrl: source.url, quote: source.text },
    request(),
    now,
  );
  expect(quote).toBe(`${source.text} [[SOURCE_URL:${source.url}]]`);
});

for (const [name, quote, url] of [
  ["wrong value", "The price of Bitcoin is 95000 USD.", source.url],
  ["wrong source", source.text, "https://example.org/bitcoin-price"],
  ["wrong asset", "The price of Ethereum is 84354.17 USD.", source.url],
  ["wrong currency", "The price of Bitcoin is 84354.17 EUR.", source.url],
] as const) {
  test(`quote repair rejects ${name}`, () => {
    expect(
      validateSharedPublicSourceQuoteRepair(
        { status: "supported", sourceUrl: url, quote },
        request(),
        now,
      ),
    ).toBeUndefined();
  });
}

test("historical and market-cap quotations cannot answer a current price", () => {
  for (const text of [
    "Last month, Bitcoin was worth 84354.17 USD.",
    "Bitcoin market cap is 84354.17 USD.",
  ]) {
    const receipt = { ...grounding, sources: [{ ...source, text }] };
    const selected = prepareSharedPublicSourceQuoteRepair(
      message,
      draft,
      receipt,
      now,
      "markets",
      authorizedQuery,
    );
    expect(selected).toBeDefined();
    if (!selected) throw new Error("Current source must admit one extraction");
    expect(
      validateSharedPublicSourceQuoteRepair(
        { status: "supported", sourceUrl: source.url, quote: text },
        selected,
        now,
      ),
    ).toBeUndefined();
  }
});

test("generic public citations reject nonnumeric claims contradicted by their source", () => {
  const url = "https://example.com/cats";
  const receipt: SharedRuntimePublicGrounding = {
    ...grounding,
    query: "cats",
    sourceUrls: [url],
    sources: [{ url, text: "Cats are mammals." }],
  };
  expect(
    finalizeSharedRealtimeReply(`Cats are reptiles. [[SOURCE_URL:${url}]]`, receipt),
  ).toContain("couldn’t verify");
  expect(finalizeSharedRealtimeReply(`Cats are mammals. ${url}`, receipt)).toContain(
    "Cats are mammals.",
  );
});
