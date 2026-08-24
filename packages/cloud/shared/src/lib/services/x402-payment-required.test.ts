import { describe, expect, it } from "vitest";
import { buildX402PaymentRequired } from "./x402-payment-required.js";

describe("buildX402PaymentRequired", () => {
  it("builds v2 envelope with resource and accepts", () => {
    const req = {
      resource: "https://example.com/api",
      description: "API",
      mimeType: "application/json",
    };
    const res = buildX402PaymentRequired(req);
    expect(res.x402Version).toBe(2);
    expect(res.error).toBe("payment_required");
    expect(res.resource).toEqual({
      url: req.resource,
      description: req.description,
      mimeType: req.mimeType,
    });
    expect(res.accepts).toEqual([req]);
  });

  it("includes extensions when provided", () => {
    const req = { resource: "https://example.com", description: "desc", mimeType: "text/plain" };
    const res = buildX402PaymentRequired(req, { foo: "bar" } as never);
    expect(res).toHaveProperty("extensions");
    expect((res as never as { extensions: unknown }).extensions).toEqual({ foo: "bar" });
  });

  it("omits extensions when undefined", () => {
    const req = { resource: "https://example.com", description: "desc", mimeType: "text/plain" };
    const res = buildX402PaymentRequired(req);
    expect(res).not.toHaveProperty("extensions");
  });
});
