/**
 * Coverage for invoice IDs.
 */
import { describe, expect, it } from "vitest";

import {
  INVOICE_NAMESPACE,
  createCryptoCustomerId,
  createCryptoInvoiceId,
} from "./invoice-ids.js";

describe("invoice-ids", () => {
  it("creates invoice id", () => {
    expect(createCryptoInvoiceId("abc123")).toBe("OXAPAY_INV_abc123");
  });

  it("creates customer id", () => {
    expect(createCryptoCustomerId("org1")).toBe("OXAPAY_ORG_org1");
  });

  it("exposes namespace", () => {
    expect(INVOICE_NAMESPACE.CRYPTO.INVOICE_PREFIX).toBe("OXAPAY_INV");
    expect(INVOICE_NAMESPACE.STRIPE.INVOICE_PREFIX).toBe("");
  });

  it("handles empty payment id", () => {
    expect(createCryptoInvoiceId("")).toBe("OXAPAY_INV_");
  });
});
