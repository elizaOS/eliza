import { describe, expect, test } from "bun:test";
import { APP_SCHEME_ORIGIN_RE, CAPACITOR_WEBVIEW_ORIGIN } from "../cors-constants";
import { runWithCloudBindings } from "../runtime/cloud-bindings";
import { getCorsHeaders as getProxyCorsHeaders, isAppOrigin } from "../services/proxy/cors";
import { getCorsHeaders as getAuthCorsHeaders } from "../utils/cors";
import { isFirstPartyOrigin } from "./first-party-origin";

/** Run `fn` as an Eliza production Worker request. */
function asElizaProduction<T>(fn: () => T): T {
  return runWithCloudBindings(
    {
      CLOUD_DEPLOYMENT_ID: "",
      CLOUD_WEB_ORIGIN: "",
      NEXT_PUBLIC_APP_URL: "",
      NEXT_PUBLIC_API_URL: "",
      CLOUD_FIRST_PARTY_ORIGINS: "",
      ENVIRONMENT: "production",
    },
    fn,
  );
}

// The Capacitor WebView origins the mobile app uses on iOS and Android.
const APP_ORIGINS = ["capacitor://localhost", CAPACITOR_WEBVIEW_ORIGIN];

// Origins of the removed Electrobun desktop host. Nothing serves them now, so
// no Cloud boundary may reflect them with credentials.
const REMOVED_DESKTOP_ORIGINS = ["electrobun://localhost", "views://mainview"];

describe("credentialed app-scheme CORS", () => {
  test("the app-scheme pattern keeps Capacitor and drops Electrobun", () => {
    expect(APP_SCHEME_ORIGIN_RE.test("capacitor://localhost")).toBe(true);
    expect(CAPACITOR_WEBVIEW_ORIGIN).toBe("https://localhost");
    for (const origin of REMOVED_DESKTOP_ORIGINS) {
      expect(APP_SCHEME_ORIGIN_RE.test(origin)).toBe(false);
    }
  });

  test("the API, proxy and auth-route boundaries admit Capacitor origins", () => {
    asElizaProduction(() => {
      for (const origin of APP_ORIGINS) {
        expect(isFirstPartyOrigin(origin)).toBe(true);
        expect(isAppOrigin(origin)).toBe(true);
        expect(getProxyCorsHeaders(undefined, origin)).toMatchObject({
          "Access-Control-Allow-Origin": origin,
          "Access-Control-Allow-Credentials": "true",
        });
        expect(getAuthCorsHeaders(origin)["Access-Control-Allow-Origin"]).toBe(origin);
      }
    });
  });

  test("the API, proxy and auth-route boundaries refuse Electrobun origins", () => {
    asElizaProduction(() => {
      for (const origin of REMOVED_DESKTOP_ORIGINS) {
        expect(isFirstPartyOrigin(origin)).toBe(false);
        expect(isAppOrigin(origin)).toBe(false);
        const proxy = getProxyCorsHeaders(undefined, origin);
        expect(proxy["Access-Control-Allow-Origin"]).toBe("*");
        expect(proxy["Access-Control-Allow-Credentials"]).toBeUndefined();
        expect(getAuthCorsHeaders(origin)["Access-Control-Allow-Origin"]).toBeUndefined();
      }
    });
  });
});
