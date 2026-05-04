import { type IAgentRuntime, ModelType } from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  _resetBillExtractionCache,
  extractAmountFromText,
  extractBill,
  extractBillByRules,
  extractDueDateFromText,
  extractMerchantFromMessage,
} from "./bill-extraction.js";

function runtime(settings: Record<string, unknown> = {}): IAgentRuntime {
  return {
    getSetting: vi.fn((key: string) => settings[key]),
    useModel: vi.fn(),
  } as unknown as IAgentRuntime;
}

beforeEach(() => {
  _resetBillExtractionCache();
});

describe("bill extraction", () => {
  it("extracts currency amounts from common formats", () => {
    expect(extractAmountFromText("Amount due: $1,234.56")).toEqual({
      amount: 1234.56,
      currency: "USD",
    });
    expect(extractAmountFromText("Balance: EUR 18.50")).toEqual({
      amount: 18.5,
      currency: "EUR",
    });
    expect(extractAmountFromText("Total 42.00 GBP")).toEqual({
      amount: 42,
      currency: "GBP",
    });
  });

  it("extracts due dates without timezone shifting", () => {
    const now = new Date("2026-04-01T00:00:00.000Z");
    expect(extractDueDateFromText("Payment due 4/15", now)).toBe("2026-04-15");
    expect(extractDueDateFromText("Due by April 20, 2027", now)).toBe(
      "2027-04-20",
    );
  });

  it("derives merchant names from sender fields", () => {
    expect(
      extractMerchantFromMessage({
        from: "Stripe Receipts <receipts@stripe.com>",
      }),
    ).toBe("Stripe Receipts");
    expect(
      extractMerchantFromMessage({
        fromEmail: "billing@figma.com",
      }),
    ).toBe("Figma");
  });

  it("extracts a complete bill by rules and skips the model", async () => {
    const rt = runtime();
    const result = await extractBill(rt, {
      id: "bill-1",
      subject: "Invoice due April 20, 2026",
      from: "Acme Billing <billing@acme.test>",
      snippet: "Amount due $88.12 by April 20, 2026",
    });

    expect(result).toMatchObject({
      merchant: "Acme Billing",
      amount: 88.12,
      currency: "USD",
      dueDate: "2026-04-20",
    });
    expect(rt.useModel).not.toHaveBeenCalled();
  });

  it("uses the configured model when rules are incomplete", async () => {
    const rt = runtime({ "lifeops.emailClassifier.model": "TEXT_LARGE" });
    vi.mocked(rt.useModel).mockResolvedValueOnce(
      JSON.stringify({
        merchant: "Power Co",
        amount: 34.91,
        currency: "USD",
        dueDate: "2026-05-03",
        confidence: 0.8,
      }),
    );

    const result = await extractBill(rt, {
      id: "bill-2",
      subject: "Your bill is ready",
      fromEmail: "service@example.com",
      snippet: "Please review the latest statement.",
    });

    expect(result).toMatchObject({
      merchant: "Power Co",
      amount: 34.91,
      currency: "USD",
      dueDate: "2026-05-03",
      confidence: 0.8,
    });
    expect(rt.useModel).toHaveBeenCalledWith(ModelType.TEXT_LARGE, {
      prompt: expect.stringContaining("Extract the structured bill"),
    });
  });

  it("falls back to rule extraction when the model fails", async () => {
    const rt = runtime();
    vi.mocked(rt.useModel).mockRejectedValueOnce(
      new Error("model unavailable"),
    );

    const result = await extractBill(rt, {
      id: "bill-3",
      subject: "Statement",
      from: "Cloud Vendor <billing@cloud.test>",
      snippet: "Total due $19.99",
    });

    expect(result).toMatchObject({
      merchant: "Cloud Vendor",
      amount: 19.99,
      currency: "USD",
    });
  });

  it("returns null below the minimum confidence threshold", () => {
    expect(
      extractBillByRules({
        subject: "No amount here",
        fromEmail: "billing@example.com",
      }),
    ).toBeNull();
  });
});
