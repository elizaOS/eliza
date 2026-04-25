import { describe, expect, it, vi } from "vitest";
import type { X402Runtime } from "../types.ts";
import {
  buildStandardPaymentRequired,
  decodeXPaymentHeader,
  findMatchingPaymentConfigForStandardPayload,
  getFacilitatorSettlePostUrl,
  getFacilitatorVerifyPostUrl,
  isX402StandardPaymentPayload,
  settlePaymentPayloadViaFacilitatorPost,
  verifyPaymentPayloadViaFacilitatorPost,
} from "../x402-standard-payment.ts";

describe("x402-standard-payment", () => {
  it("decodeXPaymentHeader parses raw JSON", () => {
    const inner = {
      x402Version: 1,
      accepted: {
        scheme: "exact",
        network: "eip155:8453",
        asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        amount: "1000000",
        payTo: "0x066E94e1200aa765d0A6392777D543Aa6Dea606C",
      },
      payload: {
        signature: "0xsig",
        authorization: {
          from: "0xfrom",
          to: "0x066E94e1200aa765d0A6392777D543Aa6Dea606C",
          value: "1000000",
          validBefore: "9999999999",
          nonce:
            "0x0000000000000000000000000000000000000000000000000000000000000001",
        },
      },
    };
    const decoded = decodeXPaymentHeader(JSON.stringify(inner));
    expect(isX402StandardPaymentPayload(decoded)).toBe(true);
  });

  it("decodeXPaymentHeader parses base64(JSON)", () => {
    const inner = {
      x402Version: 1,
      accepted: {
        scheme: "exact",
        network: "eip155:8453",
        asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        amount: "1000000",
        payTo: "0x066E94e1200aa765d0A6392777D543Aa6Dea606C",
      },
      payload: {
        signature: "0xsig",
        authorization: {
          from: "0xfrom",
          to: "0x066E94e1200aa765d0A6392777D543Aa6Dea606C",
          value: "1000000",
          validBefore: "9999999999",
          nonce:
            "0x0000000000000000000000000000000000000000000000000000000000000001",
        },
      },
    };
    const b64 = Buffer.from(JSON.stringify(inner), "utf8").toString("base64");
    const decoded = decodeXPaymentHeader(b64);
    expect(isX402StandardPaymentPayload(decoded)).toBe(true);
  });

  it("findMatchingPaymentConfigForStandardPayload matches base_usdc", () => {
    const inner = {
      x402Version: 1,
      accepted: {
        scheme: "exact",
        network: "eip155:8453",
        asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        amount: "1000000",
        payTo: "0x066E94e1200aa765d0A6392777D543Aa6Dea606C",
      },
      payload: {
        signature: "0xsig",
        authorization: {
          from: "0xfrom",
          to: "0x066E94e1200aa765d0A6392777D543Aa6Dea606C",
          value: "1000000",
          validBefore: "9999999999",
          nonce:
            "0x0000000000000000000000000000000000000000000000000000000000000001",
        },
      },
    };
    expect(
      isX402StandardPaymentPayload(inner) &&
        findMatchingPaymentConfigForStandardPayload(inner, ["base_usdc"], 100)
          ?.name,
    ).toBe("base_usdc");
  });

  it("buildStandardPaymentRequired emits v2 CAIP-2 accepts", () => {
    const paymentRequired = buildStandardPaymentRequired({
      routePath: "/api/paid",
      description: "Paid route",
      priceInCents: 100,
      paymentConfigNames: ["base_usdc"],
    });

    expect(paymentRequired.x402Version).toBe(2);
    expect(paymentRequired.accepts[0]).toMatchObject({
      scheme: "exact",
      network: "eip155:8453",
      maxAmountRequired: "1000000",
      asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      payTo: "0x066E94e1200aa765d0A6392777D543Aa6Dea606C",
    });
  });

  it("findMatchingPaymentConfigForStandardPayload accepts maxAmountRequired", () => {
    const inner = {
      x402Version: 2,
      accepted: {
        scheme: "exact",
        network: "eip155:8453",
        asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        maxAmountRequired: "1000000",
        payTo: "0x066E94e1200aa765d0A6392777D543Aa6Dea606C",
      },
      payload: {
        signature: "0xsig",
        authorization: {
          from: "0xfrom",
          to: "0x066E94e1200aa765d0A6392777D543Aa6Dea606C",
          value: "1000000",
          validBefore: "9999999999",
          nonce:
            "0x0000000000000000000000000000000000000000000000000000000000000001",
        },
      },
    };

    expect(
      isX402StandardPaymentPayload(inner) &&
        findMatchingPaymentConfigForStandardPayload(inner, ["base_usdc"], 100)
          ?.name,
    ).toBe("base_usdc");
  });

  it("getFacilitatorVerifyPostUrl uses explicit setting", () => {
    const rt = {
      getSetting: (k: string) =>
        k === "X402_FACILITATOR_VERIFY_URL"
          ? "https://custom.example/verify-endpoint"
          : undefined,
    } as unknown as X402Runtime;
    expect(getFacilitatorVerifyPostUrl(rt)).toBe(
      "https://custom.example/verify-endpoint",
    );
  });

  it("getFacilitatorVerifyPostUrl derives from default facilitator URL", () => {
    const rt = {
      getSetting: () => undefined,
    } as unknown as X402Runtime;
    expect(getFacilitatorVerifyPostUrl(rt)).toBe(
      "https://x402.elizaos.ai/api/v1/x402/verify",
    );
  });

  it("facilitator URLs append verify and settle to standard base URLs", () => {
    const rt = {
      getSetting: (k: string) =>
        k === "X402_FACILITATOR_URL"
          ? "https://facilitator.example"
          : undefined,
    } as unknown as X402Runtime;

    expect(getFacilitatorVerifyPostUrl(rt)).toBe(
      "https://facilitator.example/verify",
    );
    expect(getFacilitatorSettlePostUrl(rt)).toBe(
      "https://facilitator.example/settle",
    );
  });

  it("verifyPaymentPayloadViaFacilitatorPost posts JSON and reads isValid", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ isValid: true, payer: "0xpayer" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const rt = {
      getSetting: () => undefined,
    } as unknown as X402Runtime;

    const payload = decodeXPaymentHeader(
      JSON.stringify({
        x402Version: 1,
        accepted: {
          scheme: "exact",
          network: "eip155:8453",
          asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
          amount: "1",
          payTo: "0x0",
        },
        payload: {
          signature: "0x",
          authorization: {
            from: "0xa",
            to: "0x0",
            value: "1",
            validBefore: "9",
            nonce: "0x0",
          },
        },
      }),
    );
    if (!isX402StandardPaymentPayload(payload)) throw new Error("bad fixture");

    const out = await verifyPaymentPayloadViaFacilitatorPost(rt, payload, {
      scheme: "exact",
      network: "eip155:8453",
      asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      amount: "1",
      payTo: "0x0",
    });

    expect(out).toEqual({ ok: true, payer: "0xpayer" });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://x402.elizaos.ai/api/v1/x402/verify",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "Content-Type": "application/json",
        }),
      }),
    );
    const body = JSON.parse(
      (fetchMock.mock.calls[0]?.[1] as { body: string }).body,
    );
    expect(body.paymentPayload).toEqual(payload);
    expect(body.paymentRequirements.scheme).toBe("exact");

    vi.unstubAllGlobals();
  });

  it("settlePaymentPayloadViaFacilitatorPost returns encoded payment response", async () => {
    const settleBody = {
      success: true,
      transaction: "0xtx",
      payer: "0xpayer",
      network: "eip155:8453",
    };
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify(settleBody),
    });
    vi.stubGlobal("fetch", fetchMock);

    const rt = {
      getSetting: () => undefined,
    } as unknown as X402Runtime;
    const payload = decodeXPaymentHeader(
      JSON.stringify({
        x402Version: 2,
        accepted: {
          scheme: "exact",
          network: "eip155:8453",
          asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
          amount: "1",
          payTo: "0x0",
        },
        payload: {
          signature: "0x",
          authorization: {
            from: "0xa",
            to: "0x0",
            value: "1",
            validBefore: "9",
            nonce: "0x0",
          },
        },
      }),
    );
    if (!isX402StandardPaymentPayload(payload)) throw new Error("bad fixture");

    const out = await settlePaymentPayloadViaFacilitatorPost(rt, payload, {
      scheme: "exact",
      network: "eip155:8453",
      asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      amount: "1",
      payTo: "0x0",
    });

    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.transaction).toBe("0xtx");
      expect(
        JSON.parse(Buffer.from(out.paymentResponse, "base64").toString("utf8")),
      ).toEqual(settleBody);
    }
    expect(fetchMock).toHaveBeenCalledWith(
      "https://x402.elizaos.ai/api/v1/x402/settle",
      expect.objectContaining({ method: "POST" }),
    );

    vi.unstubAllGlobals();
  });

  it("settlePaymentPayloadViaFacilitatorPost rejects 200 with ambiguous JSON (no explicit success)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({}),
      }),
    );
    const rt = {
      getSetting: () => undefined,
    } as unknown as X402Runtime;
    const payload = decodeXPaymentHeader(
      JSON.stringify({
        x402Version: 2,
        accepted: {
          scheme: "exact",
          network: "eip155:8453",
          asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
          amount: "1",
          payTo: "0x0",
        },
        payload: {
          signature: "0x",
          authorization: {
            from: "0xa",
            to: "0x0",
            value: "1",
            validBefore: "9",
            nonce: "0x0",
          },
        },
      }),
    );
    if (!isX402StandardPaymentPayload(payload)) throw new Error("bad fixture");

    const out = await settlePaymentPayloadViaFacilitatorPost(rt, payload, {
      scheme: "exact",
      network: "eip155:8453",
      asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      amount: "1",
      payTo: "0x0",
    });
    expect(out).toEqual({ ok: false, invalidReason: "settle_http_200" });

    vi.unstubAllGlobals();
  });

  it("settlePaymentPayloadViaFacilitatorPost rejects explicit success false", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({ success: false, errorReason: "already_settled" }),
      }),
    );
    const rt = {
      getSetting: () => undefined,
    } as unknown as X402Runtime;
    const payload = decodeXPaymentHeader(
      JSON.stringify({
        x402Version: 2,
        accepted: {
          scheme: "exact",
          network: "eip155:8453",
          asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
          amount: "1",
          payTo: "0x0",
        },
        payload: {
          signature: "0x",
          authorization: {
            from: "0xa",
            to: "0x0",
            value: "1",
            validBefore: "9",
            nonce: "0x0",
          },
        },
      }),
    );
    if (!isX402StandardPaymentPayload(payload)) throw new Error("bad fixture");

    await expect(
      settlePaymentPayloadViaFacilitatorPost(rt, payload, {
        scheme: "exact",
        network: "eip155:8453",
        asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        amount: "1",
        payTo: "0x0",
      }),
    ).resolves.toEqual({ ok: false, invalidReason: "already_settled" });

    vi.unstubAllGlobals();
  });
});
