import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { runInNewContext } from "node:vm";
import { onRequest } from "../../app/functions/_middleware";

const state = "a".repeat(43),
  challenge = "b".repeat(43);
const loopback = "http://127.0.0.1:5487";
const scriptFrom = (html: string) => {
  const match = /<script(?: [^>]*)?>([\s\S]*?)<\/script>/.exec(html);
  if (!match) throw new Error("No callback script");
  return match[1];
};

for (const [web, api, tenant] of [
  [
    "https://staging.eliza.app",
    "https://api-staging.eliza.app",
    "elizacloud-staging",
  ],
  ["https://eliza.app", "https://api.eliza.app", "elizacloud"],
] as const) {
  describe(web, () => {
    const redirectUri = `${web}/alphaphone/auth/callback`;
    const env = {
      ELIZA_NATIVE_AUTH_CALLBACKS_JSON: JSON.stringify([
        {
          redirectUri,
          androidPackage: "ai.elizaresearch.alphaphone",
          appName: "Alpha Phone",
        },
      ]),
    };
    const send = (path: string, init?: RequestInit) =>
      onRequest({
        request: new Request(web + path, init),
        env,
        next: async () => new Response("Unexpected route", { status: 404 }),
      });

    test("registered scoped browser launch retains only the exact initiating origin", async () => {
      const route = "/alphaphone/auth/browser-start";
      expect(await (await send(route)).json()).toEqual({ version: 1 });
      const start = await send(route, {
        method: "POST",
        headers: { Origin: loopback },
        body: new URLSearchParams({ state, challenge }),
      });
      expect(start.status).toBe(200);
      expect(start.headers.get("Cache-Control")).toBe("no-store");
      const storage = new Map<string, string>();
      let destination = "";
      const sessionStorage = {
        setItem: (k: string, v: string) => storage.set(k, v),
        getItem: (k: string) => storage.get(k),
        removeItem: (k: string) => storage.delete(k),
      };
      runInNewContext(scriptFrom(await start.text()), {
        sessionStorage,
        location: {
          replace: (value: string) => {
            destination = value;
          },
        },
      });
      const authorize = new URL(destination);
      expect(authorize.origin).toBe(api);
      expect(authorize.pathname).toBe("/steward/auth/oauth/google/authorize");
      expect(authorize.searchParams.get("tenant_id")).toBe(tenant);
      expect(authorize.searchParams.get("redirect_uri")).toBe(redirectUri);
      expect(authorize.searchParams.get("code_challenge")).toBe(challenge);
      expect(authorize.searchParams.get("state")).toBe(state);

      const callback = await send("/alphaphone/auth/callback");
      const script = scriptFrom(await callback.text());
      const hash = createHash("sha256").update(script).digest("base64");
      expect(callback.headers.get("Content-Security-Policy")).toContain(
        `sha256-${hash}`,
      );
      let scrubbed = false;
      const runReturn = (hash: string) =>
        runInNewContext(script, {
          sessionStorage,
          URL,
          URLSearchParams,
          document: { documentElement: {} },
          location: {
            hash,
            search: "",
            pathname: "/alphaphone/auth/callback",
            replace: (value: string) => {
              destination = value;
            },
          },
          history: {
            replaceState: () => {
              scrubbed = true;
            },
          },
        });
      destination = "";
      runReturn(`#state=${"z".repeat(43)}&code=foreign`);
      expect(destination).toBe("");
      runReturn(`#state=${state}&code=one-time-test-code`);
      expect(scrubbed).toBe(true);
      expect(destination).toBe(
        loopback +
          "/__alpha-browser-cloud/signin-return#state=" +
          state +
          "&code=one-time-test-code",
      );
      destination = "";
      runReturn(`#state=${state}&code=replay`);
      expect(destination).toBe("");
    });

    test("launch rejects a foreign, invalid or unbound browser origin", async () => {
      for (const origin of [
        "https://other.invalid",
        "null",
        "http://127.0.0.1:99999",
        "http://localhost.evil.test:5487",
      ]) {
        const response = await send("/alphaphone/auth/browser-start", {
          method: "POST",
          headers: { Origin: origin },
          body: new URLSearchParams({ state, challenge }),
        });
        expect(response.status).toBe(400);
      }
      const response = await onRequest({
        request: new Request(`${web}/alphaphone/auth/browser-start`),
        env: {},
        next: async () => new Response("Unexpected route"),
      });
      expect(response.status).toBe(404);
    });
  });
}
