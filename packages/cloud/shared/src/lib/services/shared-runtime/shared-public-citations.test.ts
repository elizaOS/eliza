/** Natural-citation binding regressions. These synthetic sources contain no owner data. */
import { expect, test } from "bun:test";
import type { SharedRuntimePublicGrounding } from "../../../db/schemas/shared-runtime-history";
import {
  finalizeSharedRealtimeReply,
  normalizeSharedPublicCitations,
} from "./shared-realtime-grounding";

const source = {
  url: "https://example.com/bitcoin-price",
  text: "The current price of Bitcoin is 84354.17 USD.",
};
const grounding: SharedRuntimePublicGrounding = {
  kind: "web_search",
  query: "bitcoin price usd",
  provider: "parallel",
  observedAt: Date.parse("2026-10-10T10:00:00Z"),
  sources: [source],
  sourceUrls: [source.url],
  text: JSON.stringify({ results: [source] }),
  truncated: false,
};
const marker = `[[SOURCE_URL:${source.url}]]`;
const claim = "The price of Bitcoin is 84354.17 USD.";
const REFUSAL = "couldn’t verify an answer from the sources I found";
const OMISSION = "I found part of the answer:";

for (const [name, citation] of [
  ["Markdown link", `[source](${source.url})`],
  ["host-labelled Markdown link", `[example.com](${source.url})`],
  ["angle link", `<${source.url}>`],
  ["parenthesized URL", `(${source.url})`],
  ["bare URL", source.url],
  ["bare URL with sentence punctuation", `${source.url}.`],
] as const) {
  test(`a supported claim cited with a ${name} is delivered`, () => {
    const reply = finalizeSharedRealtimeReply(`${claim} ${citation}`, grounding);
    expect(reply).toContain(claim);
    expect(reply).toContain(`Source: ${source.url}`);
    expect(reply).not.toContain("parallel");
    expect(reply).not.toContain("checked ");
    expect(reply).not.toContain("[[SOURCE_URL:");
    expect(reply).not.toContain(REFUSAL);
    expect(reply).not.toContain(OMISSION);
  });
}

test("natural citations become the receipt's own marker", () => {
  expect(normalizeSharedPublicCitations(`${claim} [source](${source.url})`, grounding)).toBe(
    `${claim}  ${marker}`,
  );
  expect(normalizeSharedPublicCitations(`${claim} ${marker}`, grounding)).toBe(
    `${claim} ${marker}`,
  );
});

test("a natural citation does not make an unsupported claim deliverable", () => {
  for (const reply of [
    `The price of Bitcoin is 95000 USD. ${source.url}`,
    `The price of Bitcoin is 95000 USD. [source](${source.url})`,
    // A fact-bearing link label stays inside the checked claim.
    `Bitcoin. [The price of Bitcoin is 95000 USD](${source.url})`,
  ]) {
    expect(finalizeSharedRealtimeReply(reply, grounding)).toContain(REFUSAL);
  }
});

test("a URL outside the receipt is never promoted to a citation", () => {
  const foreign = "https://example.org/bitcoin-price";
  expect(normalizeSharedPublicCitations(`${claim} ${foreign}`, grounding)).toBe(
    `${claim} ${foreign}`,
  );
  expect(normalizeSharedPublicCitations(`${claim} [source](${foreign})`, grounding)).toBe(
    `${claim} [source](${foreign})`,
  );
  expect(finalizeSharedRealtimeReply(`${claim} ${foreign}`, grounding)).toContain(REFUSAL);
  expect(finalizeSharedRealtimeReply(`${claim} ${foreign} ${marker}`, grounding)).toContain(
    REFUSAL,
  );
});

test("a malformed explicit marker is not repaired", () => {
  const malformed = `${claim} [[SOURCE_URL:not a url]] ${source.url}`;
  expect(normalizeSharedPublicCitations(malformed, grounding)).toBe(malformed);
});

test("closing punctuation after a citation is not reported as omitted text", () => {
  const reply = finalizeSharedRealtimeReply(
    `The price of Bitcoin is 84354.17 USD ${marker}.`,
    grounding,
  );
  expect(reply).toStartWith("The price of Bitcoin is 84354.17 USD.\n\nSource: ");
  expect(reply).not.toContain(OMISSION);
});

test("an uncited trailing claim is still reported as omitted", () => {
  const reply = finalizeSharedRealtimeReply(`${claim} ${marker} Ethereum is 4000 USD.`, grounding);
  expect(reply).toContain(claim);
  expect(reply).not.toContain("Ethereum");
  expect(reply).toContain(OMISSION);
});

test("punctuation after a rejected final claim is not attached to earlier text", () => {
  const reply = finalizeSharedRealtimeReply(
    `${claim} ${marker} Ethereum is 4000 USD ${marker}!`,
    grounding,
  );
  expect(reply).toStartWith(`${OMISSION}\n\n${claim}`);
});
