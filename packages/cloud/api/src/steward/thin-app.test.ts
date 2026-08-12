/**
 * Isolated thin Steward shell tests (#18049). Avoids importing the full Worker
 * entrypoint so these run without the monolithic bootstrap dependency graph.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import type { AppEnv } from "@/types/cloud-worker-env";
import {
  embeddedStewardHandler,
  resetProvidersResponseCacheForTests,
} from "./embedded";
import { isThinStewardPublicPath } from "./public-paths";
import { createStewardThinApp } from "./thin-app";

const UPSTREAM = "https://steward.example.test";

const stewardEnv = {
  ENVIRONMENT: "test",
  NODE_ENV: "test",
  ELIZA_DEPLOY_COMMIT: "test-commit-18049-thin",
  STEWARD_API_URL: UPSTREAM,
  STEWARD_TENANT_ID: "elizacloud-staging",
  GOOGLE_CLIENT_ID: "google-client-id",
  GOOGLE_CLIENT_SECRET: "google-client-secret",
} as unknown as AppEnv["Bindings"];

const originalFetch = globalThis.fetch;

beforeEach(() => {
  resetProvidersResponseCacheForTests();
  globalThis.fetch = originalFetch;
});

describe("isThinStewardPublicPath", () => {
  test("matches only login-critical Steward GETs", () => {
    expect(isThinStewardPublicPath("/steward/auth/providers")).toBe(true);
    expect(isThinStewardPublicPath("/steward/auth/providers/")).toBe(true);
    expect(isThinStewardPublicPath("/steward/tenants/config")).toBe(true);
    expect(isThinStewardPublicPath("/steward/auth/email/send")).toBe(false);
    expect(isThinStewardPublicPath("/steward/auth/nonce")).toBe(false);
    expect(isThinStewardPublicPath("/api/v1/oauth/providers")).toBe(false);
  });
});

describe("createStewardThinApp", () => {
  test("proxies GET /steward/auth/providers and patches OAuth from env", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      expect(url).toBe(`${UPSTREAM}/auth/providers`);
      return Response.json({
        ok: true,
        data: {
          passkey: true,
          email: true,
          siwe: false,
          siws: false,
          google: false,
          discord: false,
          github: false,
          oauth: [],
        },
      });
    }) as typeof fetch;

    const app = createStewardThinApp();
    const response = await app.request(
      "https://api.elizacloud.ai/steward/auth/providers",
      {
        method: "GET",
        headers: { origin: "https://app.elizacloud.ai" },
      },
      stewardEnv,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("x-eliza-providers-cache")).toBe("miss");
    const body = (await response.json()) as {
      ok?: boolean;
      data?: { google?: boolean; passkey?: boolean };
    };
    expect(body.ok).toBe(true);
    expect(body.data?.passkey).toBe(true);
    expect(body.data?.google).toBe(true);
  });

  test("serves GET /steward/tenants/config without upstream", async () => {
    let upstreamCalls = 0;
    globalThis.fetch = (async () => {
      upstreamCalls += 1;
      return new Response("nope", { status: 500 });
    }) as typeof fetch;

    const app = createStewardThinApp();
    const response = await app.request(
      "https://api.elizacloud.ai/steward/tenants/config",
      { method: "GET" },
      stewardEnv,
    );

    expect(response.status).toBe(200);
    expect(upstreamCalls).toBe(0);
    const body = (await response.json()) as {
      ok?: boolean;
      data?: { features?: { enableSolana?: boolean } };
    };
    expect(body.ok).toBe(true);
    expect(body.data?.features?.enableSolana).toBe(true);
  });

  test("reuses isolate providers cache on the second GET", async () => {
    let upstreamCalls = 0;
    globalThis.fetch = (async () => {
      upstreamCalls += 1;
      return Response.json({
        ok: true,
        data: {
          passkey: true,
          email: true,
          google: false,
          oauth: [],
        },
      });
    }) as typeof fetch;

    const app = createStewardThinApp();
    const first = await app.request(
      "https://api.elizacloud.ai/steward/auth/providers",
      { method: "GET" },
      stewardEnv,
    );
    const second = await app.request(
      "https://api.elizacloud.ai/steward/auth/providers",
      { method: "GET" },
      stewardEnv,
    );

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(first.headers.get("x-eliza-providers-cache")).toBe("miss");
    expect(second.headers.get("x-eliza-providers-cache")).toBe("hit");
    expect(upstreamCalls).toBe(1);
  });
});

describe("embeddedStewardHandler providers cache", () => {
  test("returns 503 when upstream is not configured", async () => {
    const app = createStewardThinApp();
    const response = await app.request(
      "https://api.elizacloud.ai/steward/auth/providers",
      { method: "GET" },
      {
        ENVIRONMENT: "test",
        NODE_ENV: "test",
      } as unknown as AppEnv["Bindings"],
    );
    expect(response.status).toBe(503);
    const body = (await response.json()) as { error?: string };
    expect(body.error).toBe("steward_upstream_not_configured");
  });

  test("handler is the same middleware used by the thin shell", () => {
    expect(typeof embeddedStewardHandler).toBe("function");
  });
});
