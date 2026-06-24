import { describe, expect, it } from "vitest";
import { handleI18nLocaleRoute } from "./i18n-locale-routes";

function createReq(path: string, headers: Record<string, string> = {}) {
  return {
    method: "GET",
    url: path,
    headers,
  } as any;
}

function createRes() {
  const headers = new Map<string, string>();
  const res = {
    headersSent: false,
    statusCode: 0,
    body: "",
    setHeader(name: string, value: string) {
      headers.set(name.toLowerCase(), value);
    },
    end(chunk: string) {
      this.headersSent = true;
      this.body = chunk;
    },
    header(name: string) {
      return headers.get(name.toLowerCase());
    },
  };
  return res as any;
}

describe("handleI18nLocaleRoute", () => {
  it("returns the preferred supported Accept-Language match", async () => {
    const res = createRes();
    const handled = await handleI18nLocaleRoute(
      createReq("/api/i18n/locale", {
        "accept-language": "de-DE,de;q=0.9,es-MX;q=0.8,en;q=0.7",
      }),
      res,
    );

    expect(handled).toBe(true);
    expect(res.statusCode).toBe(200);
    expect(res.header("content-type")).toBe("application/json; charset=utf-8");
    expect(JSON.parse(res.body)).toEqual({ language: "es" });
  });

  it("falls back to CDN country headers when Accept-Language is unmapped", async () => {
    const res = createRes();
    const handled = await handleI18nLocaleRoute(
      createReq("/api/i18n/locale", {
        "accept-language": "de-DE,de;q=0.9",
        "cf-ipcountry": "BR",
      }),
      res,
    );

    expect(handled).toBe(true);
    expect(JSON.parse(res.body)).toEqual({ language: "pt" });
  });

  it("returns null when no supported hint exists", async () => {
    const res = createRes();
    const handled = await handleI18nLocaleRoute(
      createReq("/api/i18n/locale", {
        "accept-language": "de-DE,de;q=0.9",
      }),
      res,
    );

    expect(handled).toBe(true);
    expect(JSON.parse(res.body)).toEqual({ language: null });
  });

  it("does not claim unrelated routes", async () => {
    const res = createRes();
    await expect(handleI18nLocaleRoute(createReq("/api/health"), res)).resolves.toBe(
      false,
    );
  });
});
