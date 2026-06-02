import { describe, expect, it } from "vitest";
import { parseX402Response } from "../../src/cloud/x402-payment-handler";

describe("parseX402Response", () => {
  it("parses a synthetic 402 JSON body with paymentRequirements", async () => {
    const body = JSON.stringify({
      paymentRequirements: [
        {
          amount: "1500000",
          asset: "USDC",
          network: "base",
          payTo: "0xabc123",
          scheme: "exact",
          expiresAt: "2026-04-19T12:00:00Z",
          description: "Eliza Cloud credit top-up",
        },
      ],
    });
    const response = new Response(body, {
      status: 402,
      headers: { "Content-Type": "application/json" },
    });

    const requirements = await parseX402Response(response);
    expect(requirements).not.toBeNull();
    expect(requirements).toHaveLength(1);
    const req = requirements![0]!;
    expect(req.amount).toBe("1500000");
    expect(req.asset).toBe("USDC");
    expect(req.network).toBe("base");
    expect(req.payTo).toBe("0xabc123");
    expect(req.scheme).toBe("exact");
    expect(req.expiresAt).toBe("2026-04-19T12:00:00Z");
    expect(req.description).toBe("Eliza Cloud credit top-up");
  });

  it("parses a WWW-Authenticate header form", async () => {
    const headerJson = JSON.stringify({
      paymentRequirements: [
        {
          amount: "500000",
          asset: "USDC",
          network: "base",
          payTo: "0xdef",
        },
      ],
    });
    const response = new Response("{}", {
      status: 402,
      headers: {
        "Content-Type": "application/json",
        "WWW-Authenticate": `x402 ${headerJson}`,
      },
    });

    const requirements = await parseX402Response(response);
    expect(requirements).toHaveLength(1);
    expect(requirements![0]!.scheme).toBe("exact");
    expect(requirements![0]!.payTo).toBe("0xdef");
  });

  it("returns null when no requirements are present", async () => {
    const response = new Response("{}", {
      status: 402,
      headers: { "Content-Type": "application/json" },
    });
    const requirements = await parseX402Response(response);
    expect(requirements).toBeNull();
  });
});
