/**
 * POST /api/cloud/billing/checkout and /crypto/quote must 400 malformed JSON
 * before auth, DNS, or upstream money calls. Stock parseJsonBody used bare
 * JSON.parse, so `{` threw out of the handler.
 */
import type http from "node:http";
import { describe, expect, it, vi } from "vitest";
import { handleCloudBillingRoute } from "../src/host-routes";

function makeResponse() {
  let statusCode = 200;
  let raw = "";
  const res = {
    headersSent: false,
    setHeader: vi.fn(),
    end: (chunk?: string) => {
      if (typeof chunk === "string") raw = chunk;
      (res as { headersSent: boolean }).headersSent = true;
    },
    get statusCode() {
      return statusCode;
    },
    set statusCode(value: number) {
      statusCode = value;
    },
  } as unknown as http.ServerResponse;
  return {
    res,
    get statusCode() {
      return statusCode;
    },
    get body(): unknown {
      return raw ? JSON.parse(raw) : undefined;
    },
  };
}

function makeReq(raw: string, url: string): http.IncomingMessage {
  return {
    url,
    method: "POST",
    body: raw,
    readableEnded: true,
  } as http.IncomingMessage & { body: string };
}

async function post(pathname: string, raw: string) {
  const cap = makeResponse();
  const handled = await handleCloudBillingRoute(makeReq(raw, pathname), cap.res, pathname, "POST", {
    config: {},
    runtime: null,
  });
  return { handled, cap };
}

describe("billing checkout/quote JSON body", () => {
  it.each([
    ["/api/cloud/billing/checkout", "{"],
    ["/api/cloud/billing/checkout", "[]"],
    ["/api/cloud/billing/checkout", '"x"'],
    ["/api/cloud/billing/checkout", "null"],
    ["/api/cloud/billing/crypto/quote", "{"],
    ["/api/cloud/billing/crypto/quote", "[]"],
    ["/api/cloud/billing/crypto/quote", "1"],
  ])("%s 400s %s before auth", async (pathname, raw) => {
    const { handled, cap } = await post(pathname, raw);
    expect(handled).toBe(true);
    expect(cap.statusCode).toBe(400);
    expect(cap.body).toMatchObject({ error: "Invalid JSON body" });
  });

  it("still 401s canonical checkout JSON when disconnected", async () => {
    const { handled, cap } = await post("/api/cloud/billing/checkout", '{"amountUsd":10}');
    expect(handled).toBe(true);
    expect(cap.statusCode).toBe(401);
  });
});
