/**
 * Unit tests for `applyPaymentProtection`'s route-wrapping and 402-response
 * behavior. Runtime, request, and response objects are hand-built fakes and
 * `fetch` is stubbed where exercised — no real HTTP dispatch, facilitator,
 * or on-chain verification is involved.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyPaymentProtection,
  isRoutePaymentWrapped,
} from "./payment-wrapper.js";

function makeResponse() {
  const res = {
    headersSent: false,
    statusCode: 200,
    headers: new Map<string, string>(),
    setHeader: vi.fn((name: string, value: string) => {
      res.headers.set(name, value);
      return res;
    }),
    status: vi.fn((code: number) => {
      res.statusCode = code;
      return res;
    }),
    json: vi.fn((body: unknown) => body),
  };
  return res;
}

function decodePaymentRequiredHeader(res: ReturnType<typeof makeResponse>) {
  const encoded = res.headers.get("PAYMENT-REQUIRED");
  expect(encoded).toEqual(expect.any(String));
  return JSON.parse(Buffer.from(String(encoded), "base64").toString("utf8")) as
    | Record<string, unknown>
    | undefined;
}

describe("applyPaymentProtection", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("rejects non-array route input", () => {
    expect(() => applyPaymentProtection({} as never)).toThrow(
      "routes must be an array",
    );
  });

  it("leaves unprotected routes unchanged", () => {
    const route = { path: "/free", type: "GET", handler: vi.fn() } as never;

    const [result] = applyPaymentProtection([route]);

    expect(result).toBe(route);
    expect(isRoutePaymentWrapped(result)).toBe(false);
  });

  it("wraps protected routes and returns payment-required responses", async () => {
    const handler = vi.fn();
    const route = {
      path: "/paid",
      type: "GET",
      handler,
      x402: { priceInCents: 25, paymentConfigs: ["base_usdc"] },
    } as never;
    const runtime = { agentId: "agent-1", emitEvent: vi.fn() };
    const res = makeResponse();

    const [wrapped] = applyPaymentProtection([route], {
      agentId: "agent-1",
    });

    expect(wrapped).not.toBe(route);
    expect(isRoutePaymentWrapped(wrapped)).toBe(true);

    await wrapped.handler?.(
      { method: "GET", headers: {}, query: {} } as never,
      res as never,
      runtime as never,
    );

    expect(handler).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(402);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ x402Version: 1 }),
    );
    expect(runtime.emitEvent).toHaveBeenCalledWith(
      "PAYMENT_REQUIRED",
      expect.objectContaining({
        path: "/paid",
        reason: "payment_required",
      }),
    );
    expect(res.headers.get("Access-Control-Expose-Headers")).toContain(
      "PAYMENT-REQUIRED",
    );
    expect(decodePaymentRequiredHeader(res)).toEqual(
      expect.objectContaining({
        error: "Payment Required",
      }),
    );
  });

  it("handles route requests with missing optional headers and query", async () => {
    const handler = vi.fn();
    const route = {
      path: "/paid",
      type: "POST",
      handler,
      x402: { priceInCents: 10, paymentConfigs: ["base_usdc"] },
    } as never;
    const runtime = { agentId: "agent-1", emitEvent: vi.fn() };
    const res = makeResponse();
    const [wrapped] = applyPaymentProtection([route], {
      agentId: "agent-1",
    });

    await wrapped.handler?.(
      { method: "POST" } as never,
      res as never,
      runtime as never,
    );

    expect(handler).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(402);
    expect(runtime.emitEvent).toHaveBeenCalledWith(
      "PAYMENT_REQUIRED",
      expect.objectContaining({ reason: "payment_required" }),
    );
  });

  it("returns payment-required responses when validators fail before proof checks", async () => {
    const handler = vi.fn();
    const route = {
      path: "/paid",
      type: "GET",
      handler,
      validator: vi.fn(async () => ({
        valid: false,
        error: {
          message: "bad request",
          details: { field: "amount" },
        },
      })),
      x402: { priceInCents: 10, paymentConfigs: ["base_usdc"] },
    } as never;
    const runtime = { agentId: "agent-1", emitEvent: vi.fn() };
    const res = makeResponse();
    const [wrapped] = applyPaymentProtection([route], {
      agentId: "agent-1",
    });

    await wrapped.handler?.(
      {
        method: "GET",
        headers: { "x-payment-id": "valid-looking-id" },
        query: {},
      } as never,
      res as never,
      runtime as never,
    );

    expect(handler).not.toHaveBeenCalled();
    expect(route.validator).toHaveBeenCalledTimes(1);
    expect(res.status).toHaveBeenCalledWith(402);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: 'bad request: {"field":"amount"}',
      }),
    );
    expect(runtime.emitEvent).toHaveBeenCalledWith(
      "PAYMENT_REQUIRED",
      expect.objectContaining({ reason: "validator_failed" }),
    );
    expect(decodePaymentRequiredHeader(res)).toEqual(
      expect.objectContaining({
        error: 'bad request: {"field":"amount"}',
      }),
    );
  });

  it("rejects hostile payment ids before facilitator fetch", async () => {
    const handler = vi.fn();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const route = {
      path: "/paid",
      type: "GET",
      handler,
      x402: { priceInCents: 10, paymentConfigs: ["base_usdc"] },
    } as never;
    const runtime = {
      agentId: "agent-1",
      emitEvent: vi.fn(),
      getSetting: vi.fn(() => "https://facilitator.test"),
    };
    const res = makeResponse();
    const [wrapped] = applyPaymentProtection([route], {
      agentId: "agent-1",
    });

    await wrapped.handler?.(
      {
        method: "GET",
        headers: { "x-payment-id": "../paid\n" },
        query: {},
      } as never,
      res as never,
      runtime as never,
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(402);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: "Payment verification failed",
      }),
    );
    expect(runtime.emitEvent).toHaveBeenCalledWith(
      "PAYMENT_REQUIRED",
      expect.objectContaining({ reason: "verification_failed" }),
    );
  });

  it("does not wrap routes that are already marked as wrapped", () => {
    const route = {
      path: "/paid",
      type: "GET",
      handler: vi.fn(),
      x402: { priceInCents: 25, paymentConfigs: ["base_usdc"] },
    } as never;

    const [wrapped] = applyPaymentProtection([route]);
    const firstHandler = wrapped.handler;
    const [again] = applyPaymentProtection([wrapped]);

    expect(again).toBe(wrapped);
    expect(again.handler).toBe(firstHandler);
    expect(isRoutePaymentWrapped(again)).toBe(true);
  });
});
