/**
 * Provider-discovery release tests drive the verifier against deterministic
 * HTTP boundaries and prove that failures cannot republish upstream content.
 */

import { describe, expect, test } from "bun:test";
import {
  isProviderDiscoveryPayload,
  main,
  parseProviderDiscoveryArgs,
  parseProviderDiscoveryJson,
  verifyStewardProviderDiscovery,
  verifyStewardProviderDiscoveryWithRetry,
} from "../verify-steward-provider-discovery.mjs";

const PROVIDERS = {
  passkey: true,
  email: true,
  sms: true,
  siwe: true,
  siws: true,
  google: true,
  discord: true,
  github: true,
  twitter: true,
  telegram: true,
  oauth: ["google", "discord", "github", "twitter"],
};

const UPSTREAM = {
  baseUrl: "https://steward-api-staging.up.railway.app",
  environment: "staging",
  surface: "upstream",
};

const PROXY = {
  baseUrl: "https://api-staging.eliza.app",
  environment: "staging",
  surface: "proxy",
};

function validResponse(
  body: unknown = { ok: true, data: PROVIDERS },
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json", ...headers },
  });
}

describe("provider discovery contract", () => {
  test("accepts flat and nested valid provider contracts", () => {
    expect(isProviderDiscoveryPayload({ ok: true, ...PROVIDERS })).toBe(true);
    expect(isProviderDiscoveryPayload({ ok: true, data: PROVIDERS })).toBe(
      true,
    );
    expect(
      isProviderDiscoveryPayload({
        ok: true,
        ...PROVIDERS,
        data: { futureEnvelopeField: true },
      }),
    ).toBe(true);
  });

  test.each([
    '{"ok":true,"ok":true}',
    '{"ok":true,"__proto__":{}}',
    `${"[".repeat(18)}0${"]".repeat(18)}`,
  ])("rejects duplicate, dangerous, or excessive JSON %#", (body) => {
    expect(() => parseProviderDiscoveryJson(body)).toThrow();
  });

  test.each([
    null,
    { ok: false, data: PROVIDERS },
    { ok: true, error: "failed", data: PROVIDERS },
    { ok: true, data: { ...PROVIDERS, passkey: "yes" } },
    { ok: true, data: { ...PROVIDERS, oauth: "google" } },
    {
      ok: true,
      data: { ...PROVIDERS, captcha: { requiredFor: ["unknown"] } },
    },
  ])("rejects malformed provider state %#", (payload) => {
    expect(isProviderDiscoveryPayload(payload)).toBe(false);
  });
});

describe("provider discovery HTTP verifier", () => {
  test("rejects non-staging targets before the exported verifier can send a request", async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      return validResponse();
    };
    await expect(
      verifyStewardProviderDiscovery(
        { ...UPSTREAM, baseUrl: "https://eliza.steward.fi" },
        { fetchImpl },
      ),
    ).rejects.toThrow("not a canonical staging upstream origin");
    await expect(
      verifyStewardProviderDiscoveryWithRetry(
        {
          ...PROXY,
          environment: "production",
          baseUrl: "https://api.eliza.app",
        },
        { fetchImpl },
      ),
    ).rejects.toThrow("--environment must be staging");
    expect(calls).toBe(0);
  });

  test("probes the direct upstream with the canonical staging tenant", async () => {
    let requestedUrl = "";
    let requestedHeaders = new Headers();
    const result = await verifyStewardProviderDiscovery(UPSTREAM, {
      fetchImpl: async (input: string | URL | Request, init?: RequestInit) => {
        requestedUrl = String(input);
        requestedHeaders = new Headers(init?.headers);
        return validResponse();
      },
    });

    expect(result).toEqual({ environment: "staging", surface: "upstream" });
    expect(requestedUrl).toBe(
      "https://steward-api-staging.up.railway.app/auth/providers",
    );
    expect(requestedHeaders.get("x-steward-tenant")).toBe("elizacloud-staging");
  });

  test("requires the deployed proxy to prove the thin path", async () => {
    const methods: string[] = [];
    const result = await verifyStewardProviderDiscovery(PROXY, {
      fetchImpl: async (_input: string | URL | Request, init?: RequestInit) => {
        methods.push(init?.method ?? "GET");
        const headers = {
          "content-type": "application/json",
          "x-eliza-steward-path": "thin",
        };
        return init?.method === "HEAD"
          ? new Response(null, { status: 200, headers })
          : validResponse({ ok: true, ...PROVIDERS }, headers);
      },
    });
    expect(result).toEqual({ environment: "staging", surface: "proxy" });
    expect(methods).toEqual(["GET", "HEAD"]);

    await expect(
      verifyStewardProviderDiscovery(PROXY, {
        fetchImpl: async () => validResponse({ ok: true, ...PROVIDERS }),
      }),
    ).rejects.toThrow("did not traverse the thin Steward path");
  });

  test("fails closed when proxy HEAD is unhealthy or leaves the thin path", async () => {
    const privateBody = "private-head-detail-must-not-escape";
    let failure: Error | undefined;
    try {
      await verifyStewardProviderDiscovery(PROXY, {
        fetchImpl: async (
          _input: string | URL | Request,
          init?: RequestInit,
        ) =>
          init?.method === "HEAD"
            ? new Response(privateBody, { status: 405 })
            : validResponse(undefined, { "x-eliza-steward-path": "thin" }),
      });
    } catch (error) {
      failure = error as Error;
    }
    expect(failure?.message).toBe(
      "provider discovery proxy HEAD returned HTTP 405",
    );
    expect(failure?.message).not.toContain(privateBody);

    await expect(
      verifyStewardProviderDiscovery(PROXY, {
        fetchImpl: async (
          _input: string | URL | Request,
          init?: RequestInit,
        ) =>
          init?.method === "HEAD"
            ? new Response(null, {
                status: 200,
                headers: { "content-type": "application/json" },
              })
            : validResponse(undefined, { "x-eliza-steward-path": "thin" }),
      }),
    ).rejects.toThrow("proxy HEAD did not traverse the thin Steward path");
  });

  test("reports only status when an upstream failure body contains private data", async () => {
    const privateBody = "private-tenant-detail-must-not-escape";
    let failure: Error | undefined;
    try {
      await verifyStewardProviderDiscovery(UPSTREAM, {
        fetchImpl: async () => new Response(privateBody, { status: 404 }),
      });
    } catch (error) {
      failure = error as Error;
    }
    expect(failure?.message).toBe(
      "provider discovery upstream returned HTTP 404",
    );
    expect(failure?.message).not.toContain(privateBody);
  });

  test.each([
    [
      "non-JSON media type",
      () => new Response("text", { headers: { "content-type": "text/plain" } }),
    ],
    [
      "invalid JSON",
      () =>
        new Response("{bad", {
          headers: { "content-type": "application/json" },
        }),
    ],
    ["invalid provider contract", () => validResponse({ ok: true })],
  ])("rejects %s without body output", async (reason, response) => {
    await expect(
      verifyStewardProviderDiscovery(UPSTREAM, {
        fetchImpl: async () => response(),
      }),
    ).rejects.toThrow(reason);
  });

  test("rejects a body beyond the bounded release-proof limit", async () => {
    const oversized = `{"ok":true,"padding":"${"x".repeat(70_000)}"}`;
    await expect(
      verifyStewardProviderDiscovery(UPSTREAM, {
        fetchImpl: async () =>
          new Response(oversized, {
            headers: { "content-type": "application/json" },
          }),
      }),
    ).rejects.toThrow("exceeds the safe limit");
  });

  test("does not reflect network or stream exception messages", async () => {
    const privateDetail = "safe limit private-upstream-detail-must-not-escape";
    await expect(
      verifyStewardProviderDiscovery(UPSTREAM, {
        fetchImpl: async () => {
          throw new Error(privateDetail);
        },
      }),
    ).rejects.toThrow(/^provider discovery upstream request failed$/);

    await expect(
      verifyStewardProviderDiscovery(UPSTREAM, {
        fetchImpl: async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.error(new Error(privateDetail));
              },
            }),
            { headers: { "content-type": "application/json" } },
          ),
      }),
    ).rejects.toThrow(/^provider discovery body could not be read$/);
  });

  test("keeps the size failure private when cancelling an oversized stream also fails", async () => {
    await expect(
      verifyStewardProviderDiscovery(UPSTREAM, {
        fetchImpl: async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new Uint8Array(70_000));
              },
              cancel() {
                throw new Error("private-cancel-detail-must-not-escape");
              },
            }),
            { headers: { "content-type": "application/json" } },
          ),
      }),
    ).rejects.toThrow(/^provider discovery body exceeds the safe limit$/);
  });

  test("retries bounded transient failure and then proves the contract", async () => {
    let calls = 0;
    let sleeps = 0;
    const result = await verifyStewardProviderDiscoveryWithRetry(UPSTREAM, {
      attempts: 2,
      retryDelayMs: 1,
      sleepImpl: async () => {
        sleeps += 1;
      },
      fetchImpl: async () => {
        calls += 1;
        return calls === 1
          ? new Response("down", { status: 503 })
          : validResponse();
      },
    });
    expect(result.surface).toBe("upstream");
    expect(calls).toBe(2);
    expect(sleeps).toBe(1);
  });
});

describe("provider discovery CLI", () => {
  test("rejects cross-environment, credentialed, duplicate, and unknown inputs", () => {
    expect(() =>
      parseProviderDiscoveryArgs([
        "--base-url",
        "https://api.eliza.app",
        "--environment",
        "production",
        "--surface",
        "proxy",
      ]),
    ).toThrow("--environment must be staging");
    expect(() =>
      parseProviderDiscoveryArgs([
        "--base-url",
        "https://eliza.steward.fi",
        "--environment",
        "staging",
        "--surface",
        "upstream",
      ]),
    ).toThrow("not a canonical staging upstream origin");
    expect(() =>
      parseProviderDiscoveryArgs([
        "--base-url",
        "https://user@api-staging.eliza.app",
        "--environment",
        "staging",
        "--surface",
        "proxy",
      ]),
    ).toThrow("must be an HTTPS origin");
    expect(() =>
      parseProviderDiscoveryArgs([
        "--surface",
        "proxy",
        "--surface",
        "proxy",
        "--environment",
        "staging",
        "--base-url",
        PROXY.baseUrl,
      ]),
    ).toThrow("Duplicate argument");
    expect(() =>
      parseProviderDiscoveryArgs([
        "--base-url",
        PROXY.baseUrl,
        "--environment",
        "staging",
        "--target",
        "proxy",
      ]),
    ).toThrow("Unsupported argument");
  });

  test("never republishes malformed argument content", () => {
    const privateArgument = "private-cli-material-must-not-escape";
    for (const argv of [
      [privateArgument],
      [privateArgument, "value"],
      ["--base-url", `https://${privateArgument}`],
    ]) {
      let failure: Error | undefined;
      try {
        parseProviderDiscoveryArgs(argv);
      } catch (error) {
        failure = error as Error;
      }
      expect(failure).toBeDefined();
      expect(failure?.message).not.toContain(privateArgument);
    }
  });

  test("prints only the verified surface and environment", async () => {
    const logs: string[] = [];
    await main(
      [
        "--base-url",
        PROXY.baseUrl,
        "--environment",
        "staging",
        "--surface",
        "proxy",
      ],
      {
        fetchImpl: async () =>
          validResponse(
            { ok: true, data: PROVIDERS },
            { "x-eliza-steward-path": "thin" },
          ),
        log: (message: string) => logs.push(message),
        sleepImpl: async () => undefined,
      },
    );
    expect(logs).toEqual([
      "Verified anonymous Steward provider discovery through the proxy boundary for staging.",
    ]);
  });
});
