/** Web search reputation annotation: listed results warn, other results never read as safe, slow checks do not block. */
import { expect, test } from "bun:test";
import type { WebsiteReputationVerdict } from "@elizaos/cloud-sdk/website-reputation";
import { annotateSearchReputation, extractAnswerUrls, formatWebSearchText } from "./reputation";
import type { SearchResponse } from "./types";

const WARNING =
  "Known harmful site (Phishing.Database; phishing): do not open or enter information.";
const listed = (host: string): WebsiteReputationVerdict => ({
  status: "listed",
  host,
  matchedHost: host,
  sources: ["Phishing.Database"],
  categories: ["phishing"],
  warning: WARNING,
});

const search = (overrides: Partial<SearchResponse> = {}): SearchResponse => ({
  answer: "Here is what I found.",
  query: "bank login",
  responseTime: 0.2,
  images: [],
  results: [
    { title: "Real Bank", url: "https://www.realbank.example/login", content: "", score: 1 },
    { title: "Bank Verify", url: "https://secure-bank-verify.test/login", content: "", score: 0.9 },
  ],
  ...overrides,
});

test("listed results carry a warning field and a warning in the agent text", async () => {
  const annotated = await annotateSearchReputation(search(), {
    check: async (addresses) =>
      addresses.map((address) =>
        address.includes("secure-bank-verify")
          ? listed("secure-bank-verify.test")
          : { status: "not_listed", host: "www.realbank.example", label: "No known threat" },
      ),
  });
  expect(annotated.results[1].reputation).toMatchObject({ status: "listed" });
  expect(annotated.results[0].reputation).toEqual({
    status: "not_listed",
    label: "No known threat",
  });
  const text = formatWebSearchText(annotated);
  expect(text).toContain(
    "2. Bank Verify (secure-bank-verify.test) - Known harmful site (Phishing.Database; phishing): do not open or enter information.",
  );
  // The listed site is not rendered as a link; the other result is unchanged.
  expect(text).not.toContain("](https://secure-bank-verify.test/login)");
  expect(text).toContain("1. [Real Bank](https://www.realbank.example/login)");
  expect(text.toLowerCase()).not.toMatch(/\bsafe\b|no known threat|verified/);
});

test("listed addresses inside a keyless answer are warned", async () => {
  const answer = "Try https://paypa1-login.example/verify, or see (https://news.example/a).";
  expect(extractAnswerUrls(answer)).toEqual([
    "https://paypa1-login.example/verify",
    "https://news.example/a",
  ]);
  const annotated = await annotateSearchReputation(search({ answer, results: [] }), {
    check: async (addresses) =>
      addresses.map((address) =>
        address.includes("paypa1")
          ? listed("paypa1-login.example")
          : { status: "unavailable", host: "news.example", reason: "unavailable" },
      ),
  });
  expect(annotated.reputationWarnings).toEqual([
    {
      url: "https://paypa1-login.example/verify",
      host: "paypa1-login.example",
      warning: WARNING,
    },
  ]);
  expect(formatWebSearchText(annotated)).toBe(
    `${answer}\n\nWebsite warnings:\n- paypa1-login.example: Known harmful site (Phishing.Database; phishing): do not open or enter information.`,
  );
});

test("a slow or failing check leaves results unchecked and adds no text", async () => {
  const slow = await annotateSearchReputation(search(), {
    timeoutMs: 20,
    check: () => new Promise(() => {}),
  });
  expect(slow.results.map((r) => r.reputation)).toEqual([
    { status: "unavailable" },
    { status: "unavailable" },
  ]);
  const failed = await annotateSearchReputation(search(), {
    check: async () => {
      throw new Error("R2 down");
    },
  });
  expect(failed.results[0].reputation).toEqual({ status: "unavailable" });
  expect(formatWebSearchText(failed)).toBe(
    "Here is what I found.\n\nFor more details, you can check out these resources:\n1. [Real Bank](https://www.realbank.example/login)\n2. [Bank Verify](https://secure-bank-verify.test/login)",
  );
});
