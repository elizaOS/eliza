// Exercises cloud API tests steward embedded signing.test behavior with deterministic Worker route fixtures.
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppEnv } from "@/types/cloud-worker-env";
import { embeddedStewardHandler } from "../src/steward/embedded";

// gitleaks:allow — synthetic test value, no entropy / real-key shape needed.
const SECRET = "test_only_steward_secret_aaaaaaaaaaaaa";
const UPSTREAM = "https://steward.example.test";

const ORIGINAL_FETCH = globalThis.fetch;

function makeApp(envOverrides: Partial<AppEnv["Bindings"]> = {}) {
  const app = new Hono<AppEnv>();
  // The handler reads c.env via Hono — wire a stub.
  app.use(async (c, next) => {
    c.env = {
      STEWARD_API_URL: UPSTREAM,
      STEWARD_REQUEST_SIGNING_SECRET: SECRET,
      STEWARD_TENANT_ID: "elizacloud-staging",
      ...envOverrides,
    } as AppEnv["Bindings"];
    await next();
  });
  app.all("/steward/*", embeddedStewardHandler);
  app.all("/steward", embeddedStewardHandler);
  return app;
}

interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

function captureFetch(responseFactory: () => Response): {
  calls: CapturedRequest[];
  restore: () => void;
} {
  const calls: CapturedRequest[] = [];
  globalThis.fetch = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    const headers: Record<string, string> = {};
    const h = new Headers(init?.headers ?? {});
    h.forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });
    let bodyText = "";
    if (init?.body) {
      if (init.body instanceof ArrayBuffer) {
        bodyText = new TextDecoder().decode(init.body);
      } else if (typeof init.body === "string") {
        bodyText = init.body;
      }
    }
    calls.push({
      url,
      method: (init?.method ?? "GET").toUpperCase(),
      headers,
      body: bodyText,
    });
    return responseFactory();
  }) as typeof globalThis.fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = ORIGINAL_FETCH;
    },
  };
}

async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(message),
  );
  return [...new Uint8Array(sig)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function sha256Hex(value: string): Promise<string> {
  const buf = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

let captured: ReturnType<typeof captureFetch> | null = null;

beforeEach(() => {
  captured = captureFetch(
    () =>
      new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  );
});

afterEach(() => {
  captured?.restore();
  vi.restoreAllMocks();
});

describe("embeddedStewardHandler signing", () => {
  it("injects X-Steward-Request-Expires-At + X-Steward-Signature on POST", async () => {
    const FIXED_MS = Date.parse("2026-06-05T15:00:00Z");
    vi.spyOn(Date, "now").mockReturnValue(FIXED_MS);
    const app = makeApp();
    const body = JSON.stringify({ email: "stan@example.com" });
    await app.request("/steward/auth/email/send", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });

    expect(captured!.calls).toHaveLength(1);
    const c = captured!.calls[0];
    expect(c.url).toBe(`${UPSTREAM}/auth/email/send`);
    expect(c.method).toBe("POST");
    expect(c.body).toBe(body);
    expect(c.headers["x-steward-tenant"]).toBe("elizacloud-staging");
    expect(c.headers["x-steward-request-expires-at"]).toBeTruthy();
    expect(Number(c.headers["x-steward-request-expires-at"])).toBe(
      Math.floor(Date.parse("2026-06-05T15:00:00Z") / 1000) + 60,
    );
    expect(c.headers["x-steward-signature"]).toMatch(/^v1=[0-9a-f]{64}$/);
  });

  it("computed signature verifies against the canonical request", async () => {
    const FIXED_MS = Date.parse("2026-06-05T15:00:00Z");
    vi.spyOn(Date, "now").mockReturnValue(FIXED_MS);
    const app = makeApp();
    const body = JSON.stringify({ email: "stan@example.com" });
    await app.request("/steward/auth/email/send", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    const c = captured!.calls[0]!;

    const bodyHash = await sha256Hex(body);
    const canonical = [
      "steward-request-signature-v1",
      "POST",
      "/auth/email/send",
      "elizacloud-staging",
      await sha256Hex(""),
      await sha256Hex(""),
      await sha256Hex(""),
      await sha256Hex(""),
      await sha256Hex(""),
      await sha256Hex(""),
      await sha256Hex(""),
      "",
      c.headers["x-steward-request-expires-at"]!,
      c.headers["idempotency-key"]!,
      bodyHash,
    ].join("\n");
    const expected = await hmacSha256Hex(SECRET, canonical);
    expect(c.headers["x-steward-signature"]).toBe(`v1=${expected}`);
  });

  it("does NOT sign GET requests (Steward skips them on the receive side)", async () => {
    const app = makeApp();
    await app.request("/steward/auth/providers");
    const c = captured!.calls[0]!;
    expect(c.method).toBe("GET");
    expect(c.headers["x-steward-signature"]).toBeUndefined();
    expect(c.headers["x-steward-request-expires-at"]).toBeUndefined();
  });

  it("skips signing when the secret is not configured (rollback path)", async () => {
    const app = makeApp({ STEWARD_REQUEST_SIGNING_SECRET: undefined });
    await app.request("/steward/auth/email/send", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    const c = captured!.calls[0]!;
    expect(c.headers["x-steward-signature"]).toBeUndefined();
    expect(c.headers["x-steward-request-expires-at"]).toBeUndefined();
  });

  it("stamps a fresh Idempotency-Key when the SPA didn't send one", async () => {
    const app = makeApp();
    await app.request("/steward/auth/email/send", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    const c = captured!.calls[0]!;
    // RFC 4122 UUID v4: 8-4-4-4-12 hex, version=4 in slot 14, variant in slot 19.
    expect(c.headers["idempotency-key"]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it("preserves the SPA-supplied Idempotency-Key so retries dedup", async () => {
    const app = makeApp();
    const supplied = "11111111-2222-4333-8444-555555555555";
    await app.request("/steward/auth/email/send", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": supplied,
      },
      body: "{}",
    });
    const c = captured!.calls[0]!;
    expect(c.headers["idempotency-key"]).toBe(supplied);
  });

  it("returns the public tenant config short-circuit without hitting upstream", async () => {
    const app = makeApp();
    const res = await app.request("/steward/tenants/config");
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; data: unknown };
    expect(json.ok).toBe(true);
    expect(captured!.calls).toHaveLength(0);
  });

  it("maps upstream transport failures to steward_upstream_unavailable", async () => {
    captured?.restore();
    globalThis.fetch = (async () => {
      throw new Error("upstream timed out");
    }) as unknown as typeof globalThis.fetch;

    const app = makeApp();
    const res = await app.request("/steward/auth/email/send", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });

    expect(res.status).toBe(502);
    const json = (await res.json()) as { code?: string; error?: string };
    expect(json.code).toBe("steward_upstream_unavailable");
    expect(json.error).toBe("steward_upstream_unavailable");
  });
});
