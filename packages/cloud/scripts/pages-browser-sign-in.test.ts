import { describe, expect, test } from "bun:test";
import { runInNewContext } from "node:vm";
import {
  nativeSignInCallbackFallback,
  onRequest,
  selectNativeAuthCallback,
} from "../../app/functions/_middleware";
import { browserSignInStart } from "../shared/src/lib/auth/browser-sign-in";

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
    const redirectUri = `${web}/sample-app/auth/callback`;
    const browserSignIn = {
      startPath: "/sample-app/auth/browser-start",
      returnPath: "/__sample-cloud/signin-return",
      storageKey: "sample-browser-sign-in:v1",
      apiOrigin: api,
      tenant,
    };
    const registration = JSON.stringify([
      {
        redirectUri,
        androidPackage: "org.example.sample",
        appName: "Sample App",
        browserSignIn,
      },
    ]);
    const env = {
      API_WORKER: {
        fetch: async (forwarded: Request) => {
          const url = new URL(
            new URL(forwarded.url).searchParams.get("url") ?? forwarded.url,
          );
          const start = selectNativeAuthCallback(
            registration,
            url,
            "browser-start",
          );
          if (start?.browserSignIn)
            return browserSignInStart(
              new Request(url, forwarded),
              new URL(start.redirectUri),
              start.browserSignIn,
            );
          const callback = selectNativeAuthCallback(registration, url);
          return callback
            ? nativeSignInCallbackFallback(url, callback)
            : new Response("Not Found", { status: 404 });
        },
      },
    };
    const send = (path: string, init?: RequestInit) =>
      onRequest({
        request: new Request(web + path, init),
        env,
        next: async () => new Response("Unexpected route", { status: 404 }),
      });

    test("registered scoped browser launch retains only the exact initiating origin", async () => {
      const route = "/sample-app/auth/browser-start";
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

      const callback = await send("/sample-app/auth/callback");
      const html = await callback.text();
      const script = scriptFrom(html);
      const nonce = /<script nonce="([^"]+)">/.exec(html)?.[1];
      expect(nonce).toBeTruthy();
      expect(callback.headers.get("Content-Security-Policy")).toContain(
        `nonce-${nonce}`,
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
            pathname: "/sample-app/auth/callback",
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
      const pending = storage.get(browserSignIn.storageKey);
      if (!pending) throw new Error("No pending browser sign-in");
      storage.set(
        browserSignIn.storageKey,
        JSON.stringify({
          ...JSON.parse(pending),
          redirectUri: `${web}/another-client/callback`,
        }),
      );
      runReturn(`#state=${state}&code=foreign-client`);
      expect(destination).toBe("");
      storage.set(
        browserSignIn.storageKey,
        JSON.stringify({
          ...JSON.parse(pending),
          expiresAt: Date.now() - 1,
        }),
      );
      runReturn(`#state=${state}&code=expired`);
      expect(destination).toBe("");
      storage.set(browserSignIn.storageKey, pending);
      runReturn(`#state=${state}&code=one-time-test-code`);
      expect(scrubbed).toBe(true);
      expect(destination).toBe(
        loopback +
          "/__sample-cloud/signin-return#state=" +
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
        const response = await send("/sample-app/auth/browser-start", {
          method: "POST",
          headers: { Origin: origin },
          body: new URLSearchParams({ state, challenge }),
        });
        expect(response.status).toBe(400);
      }
      const response = await onRequest({
        request: new Request(`${web}/sample-app/auth/browser-start`),
        env: {},
        next: async () => new Response("Unexpected route", { status: 404 }),
      });
      expect(response.status).toBe(503);
    });
  });
}

test("independent consumers register distinct routes and storage without a package switch", async () => {
  const origin = "https://eliza.app";
  const entries = ["first", "second"].map((id) => ({
    redirectUri: `${origin}/${id}/callback`,
    androidPackage: `org.example.${id}`,
    appName: id,
    browserSignIn: {
      startPath: `/${id}/start`,
      returnPath: `/${id}/return`,
      storageKey: `${id}:pending`,
      apiOrigin: "https://api.eliza.app",
      tenant: `tenant-${id}`,
    },
  }));
  const raw = JSON.stringify(entries);
  for (const entry of entries) {
    expect(
      selectNativeAuthCallback(
        raw,
        new URL(origin + entry.browserSignIn.startPath),
        "browser-start",
      ),
    ).toEqual(entry);
    const response = await onRequest({
      request: new Request(entry.redirectUri),
      env: {
        API_WORKER: {
          fetch: async (request: Request) => {
            const url = new URL(
              new URL(request.url).searchParams.get("url") ?? request.url,
            );
            const callback = selectNativeAuthCallback(raw, url);
            return callback
              ? nativeSignInCallbackFallback(url, callback)
              : new Response("Not Found", { status: 404 });
          },
        },
      },
      next: async () => new Response("Unexpected route", { status: 404 }),
    });
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain(JSON.stringify(entry.browserSignIn.storageKey));
    expect(html).toContain(JSON.stringify(entry.browserSignIn.returnPath));
    expect(html).not.toContain(
      entries.find((other) => other !== entry)?.browserSignIn.storageKey,
    );
  }
  const invalid = [
    entries.map((entry) => ({
      ...entry,
      browserSignIn: { ...entry.browserSignIn, storageKey: "shared" },
    })),
    [
      entries[0],
      {
        ...entries[1],
        redirectUri: origin + entries[0].browserSignIn.startPath,
      },
    ],
    [
      entries[0],
      {
        ...entries[1],
        browserSignIn: {
          ...entries[1].browserSignIn,
          startPath: "/first/callback",
        },
      },
    ],
    ...[
      "https://foreign.invalid",
      "//foreign.invalid",
      "/x/../return",
      "/api/auth",
      "/assets/auth",
    ].map((returnPath) => [
      {
        ...entries[0],
        browserSignIn: { ...entries[0].browserSignIn, returnPath },
      },
    ]),
    [
      {
        ...entries[0],
        browserSignIn: {
          ...entries[0].browserSignIn,
          apiOrigin: "http://api.eliza.app",
        },
      },
    ],
    [
      {
        ...entries[0],
        browserSignIn: { ...entries[0].browserSignIn, unexpected: true },
      },
    ],
  ];
  for (const configuration of invalid) {
    expect(() =>
      selectNativeAuthCallback(JSON.stringify(configuration), new URL(origin)),
    ).toThrow();
  }
});
