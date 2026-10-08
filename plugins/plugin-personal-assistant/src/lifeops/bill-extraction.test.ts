/**
 * Regression coverage for the regex/LLM merge in bill extraction. The harness
 * drives the real exported `extractBill()` through a deterministic mock runtime
 * whose `useModel` returns a fixed JSON payload, so it exercises the actual
 * `mergeRuleAndLlm` contract that persists the merchant field the Money domain
 * consumes. The pinned case is a bill with no sender metadata whose body names a
 * short merchant ("Netflix"): the old length gate compared the LLM name against
 * the 16-char "Unknown merchant" placeholder and discarded any shorter real
 * name, corrupting the stored record. Every message uses a unique id because
 * `extractBill` caches by id, so shared ids would leak results across cases.
 */

import type { IAgentRuntime } from "@elizaos/core";
import type { EmailLikeMessage } from "@elizaos/shared";
import { describe, expect, it } from "vitest";
import {
  extractAmountFromText,
  extractBill,
  extractDueDateFromText,
} from "./bill-extraction.js";

function runtimeWithModel(response: string): IAgentRuntime {
  return {
    getSetting: () => "TEXT_SMALL",
    useModel: async () => response,
  } as unknown as IAgentRuntime;
}

const netflixPayload = JSON.stringify({
  merchant: "Netflix",
  amount: 99.99,
  currency: "EUR",
  dueDate: "2026-05-20",
  confidence: 0.9,
});

describe("extractBill merge merchant selection", () => {
  it("keeps a short LLM merchant when the message has no sender metadata", async () => {
    const message: EmailLikeMessage = {
      id: "bill-netflix-short",
      subject: "Your subscription payment",
      snippet: "Amount $49.95 due 5/20/2026",
      bodyText: "Amount $49.95 due 5/20/2026",
    };
    const bill = await extractBill(runtimeWithModel(netflixPayload), message);
    expect(bill).not.toBeNull();
    // Regression: previously "Unknown merchant" because "Netflix" (7 chars) is
    // shorter than the 16-char placeholder the length gate compared against.
    expect(bill?.merchant).toBe("Netflix");
    // Amount + currency must still come from the precise regex pass, not the LLM.
    expect(bill?.amount).toBe(49.95);
    expect(bill?.currency).toBe("USD");
  });

  it("preserves a long LLM merchant name (control that always passed)", async () => {
    const message: EmailLikeMessage = {
      id: "bill-pge-long",
      subject: "Utility statement",
      snippet: "Amount $120.00 due 6/1/2026",
      bodyText: "Amount $120.00 due 6/1/2026",
    };
    const payload = JSON.stringify({
      merchant: "Pacific Gas and Electric Company",
      amount: 120,
      currency: "USD",
      dueDate: "2026-06-01",
      confidence: 0.9,
    });
    const bill = await extractBill(runtimeWithModel(payload), message);
    expect(bill?.merchant).toBe("Pacific Gas and Electric Company");
  });

  it("prefers the regex sender display name over a different LLM merchant", async () => {
    const message: EmailLikeMessage = {
      id: "bill-comcast-from",
      from: "Comcast Billing <billing@comcast.com>",
      subject: "Statement ready",
      snippet: "Balance $75.00",
      bodyText: "Balance $75.00",
    };
    const payload = JSON.stringify({
      merchant: "Xfinity",
      amount: 75,
      currency: "USD",
      dueDate: null,
      confidence: 0.9,
    });
    const bill = await extractBill(runtimeWithModel(payload), message);
    expect(bill?.merchant).toBe("Comcast Billing");
  });

  it("stays 'Unknown merchant' when neither pass names a merchant", async () => {
    const message: EmailLikeMessage = {
      id: "bill-both-placeholder",
      subject: "Payment reminder",
      snippet: "Amount $30.00 due 7/1/2026",
      bodyText: "Amount $30.00 due 7/1/2026",
    };
    const payload = JSON.stringify({
      merchant: "",
      amount: 30,
      currency: "USD",
      dueDate: "2026-07-01",
      confidence: 0.9,
    });
    const bill = await extractBill(runtimeWithModel(payload), message);
    expect(bill?.merchant).toBe("Unknown merchant");
  });
});

describe("extractAmountFromText currency code", () => {
  it("keeps an explicit CAD code when the amount uses a dollar sign", () => {
    expect(extractAmountFromText("Amount due CAD $49.99")).toEqual({
      amount: 49.99,
      currency: "CAD",
    });
    expect(extractAmountFromText("Amount due $49.99 CAD")).toEqual({
      amount: 49.99,
      currency: "CAD",
    });
  });

  it("still maps a bare dollar sign to USD", () => {
    expect(extractAmountFromText("Amount due $49.95")).toEqual({
      amount: 49.95,
      currency: "USD",
    });
  });
});

describe("extractDueDateFromText ordinal day", () => {
  const observedAt = new Date("2027-03-01T00:00:00.000Z");

  it("keeps the written year when the day has an ordinal suffix", () => {
    expect(
      extractDueDateFromText("payment due April 15th, 2026", observedAt),
    ).toBe("2026-04-15");
  });

  it("still reads a day that has no ordinal suffix", () => {
    expect(
      extractDueDateFromText("payment due April 15, 2026", observedAt),
    ).toBe("2026-04-15");
  });
});

describe("extractBill sender-domain fallback", () => {
  it.each([
    ["receipts@mail.stripe.com", "Stripe"],
    ["billing@stripe.com", "Stripe"],
    ["billing@mail.stripe.co.uk", "Stripe"],
    ["billing@stripe.co.uk", "Stripe"],
    ["billing@alice.github.io", "Alice.github.io"],
    ["billing@bob.github.io", "Bob.github.io"],
    ["billing@mail.alice.github.io", "Alice.github.io"],
    ["billing@accounts.example.internal", "Accounts.example.internal"],
  ])(
    "keeps the correct sender fallback for %s",
    async (fromEmail, merchant) => {
      const message: EmailLikeMessage = {
        id: `merchant-domain-${fromEmail}`,
        fromEmail,
        subject: "Invoice ready",
        bodyText: "Amount $49.95 due 5/20/2026",
      };
      const bill = await extractBill(runtimeWithModel(netflixPayload), message);
      expect(bill).toMatchObject({ merchant, amount: 49.95, currency: "USD" });
    },
  );

  it("keeps the sender display name ahead of a hosting domain", async () => {
    const bill = await extractBill(runtimeWithModel(netflixPayload), {
      id: "merchant-hosted-display-name",
      from: '"Alice Studio" <billing@mail.alice.github.io>',
      fromEmail: "billing@mail.alice.github.io",
      bodyText: "Amount $49.95 due 5/20/2026",
    });
    expect(bill?.merchant).toBe("Alice Studio");
  });
});
