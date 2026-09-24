/**
 * Unit tests for `resolveSuggestedUiLanguage` and the `GET /api/i18n/locale`
 * route handler, driving fake `http.IncomingMessage`/`ServerResponse` objects
 * with a mocked `loadElizaConfig`. Covers configured-language preference,
 * Accept-Language q-value fallback, and unrelated-route pass-through.
 */
import * as http from "node:http";
import { Socket } from "node:net";
import { describe, expect, it, vi } from "vitest";
import {
  handleI18nLocaleRoute,
  resolveSuggestedUiLanguage,
} from "./i18n-locale-routes";

vi.mock("@elizaos/agent", () => ({
  loadElizaConfig: () => ({ ui: { language: "en" } }),
}));

function fakeReq(opts: {
  acceptLanguage?: string;
  method?: string;
  pathname?: string;
}): http.IncomingMessage {
  const req = new http.IncomingMessage(new Socket());
  req.method = opts.method ?? "GET";
  req.url = opts.pathname ?? "/api/i18n/locale";
  req.headers = {
    host: "localhost:2138",
    ...(opts.acceptLanguage ? { "accept-language": opts.acceptLanguage } : {}),
  };
  return req;
}

function fakeRes(): {
  body: () => unknown;
  res: http.ServerResponse;
  status: () => number;
} {
  let bodyText = "";
  const req = new http.IncomingMessage(new Socket());
  const res = new http.ServerResponse(req);
  res.statusCode = 200;
  res.setHeader = () => res;
  res.end = ((chunk?: string | Buffer) => {
    if (typeof chunk === "string") bodyText += chunk;
    else if (chunk) bodyText += chunk.toString("utf8");
    return res;
  }) as typeof res.end;
  return {
    body: () => (bodyText ? JSON.parse(bodyText) : null),
    res,
    status: () => res.statusCode,
  };
}

describe("resolveSuggestedUiLanguage", () => {
  it("prefers a configured non-English UI language", () => {
    expect(
      resolveSuggestedUiLanguage({
        acceptLanguage: "es-MX,es;q=0.9,en;q=0.8",
        configuredLanguage: "ja",
      }),
    ).toBe("ja");
  });

  it("uses the best supported Accept-Language fallback", () => {
    expect(
      resolveSuggestedUiLanguage({
        acceptLanguage: "fr-CA;q=0.8,es-MX;q=0.9,en-US;q=0.7",
      }),
    ).toBe("es");
    expect(
      resolveSuggestedUiLanguage({
        acceptLanguage: "fil-PH, en-US;q=0.8",
      }),
    ).toBe("tl");
  });

  it("falls back to English for unknown or empty inputs", () => {
    expect(resolveSuggestedUiLanguage({ acceptLanguage: "fr-CA" })).toBe("en");
    expect(resolveSuggestedUiLanguage({})).toBe("en");
  });
});

describe("GET /api/i18n/locale", () => {
  it("returns a public language suggestion payload", () => {
    const res = fakeRes();
    const handled = handleI18nLocaleRoute(
      fakeReq({ acceptLanguage: "es-MX,es;q=0.9,en;q=0.8" }),
      res.res,
    );

    expect(handled).toBe(true);
    expect(res.status()).toBe(200);
    expect(res.body()).toEqual({ language: "es" });
  });

  it("ignores unrelated routes", () => {
    const res = fakeRes();
    expect(
      handleI18nLocaleRoute(fakeReq({ pathname: "/api/status" }), res.res),
    ).toBe(false);
  });
});
