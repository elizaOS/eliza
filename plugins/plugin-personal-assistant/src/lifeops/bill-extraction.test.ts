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
import { extractBill } from "./bill-extraction.js";

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
