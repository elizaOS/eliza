/**
 * The registry host (`plugins.elizacloud.ai`) must serve the committed
 * registry artifacts from the worker itself: the wildcard `*.elizacloud.ai/*`
 * route shadows the host, so before this handler the canonical registry URL
 * (`packages/registry` README) 404'd on the JSON router on every env.
 * Deterministic — upstream raw-GitHub fetch is stubbed via the global fetch;
 * no network.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { serveRegistryHostRequest } from "./registry-host";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

function stubUpstream(
  responder: (url: string, init?: RequestInit) => Response,
): { calls: string[] } {
  const calls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    return responder(url, init);
  }) as typeof fetch;
  return { calls };
}

function req(url: string, method = "GET"): [Request, URL] {
  return [new Request(url, { method }), new URL(url)];
}

const ENV = {} as Parameters<typeof serveRegistryHostRequest>[2];

describe("serveRegistryHostRequest", () => {
  test("returns null for non-registry hosts (falls through to the router)", async () => {
    const { calls } = stubUpstream(() => new Response("{}"));
    const [request, url] = req(
      "https://api.elizacloud.ai/generated-registry.json",
    );
    expect(await serveRegistryHostRequest(request, url, ENV)).toBeNull();
    expect(calls).toHaveLength(0);
  });

  test("serves the committed artifact with a JSON content-type", async () => {
    const { calls } = stubUpstream(
      () =>
        new Response('{"registry":true}', {
          status: 200,
          headers: { "content-type": "text/plain; charset=utf-8" },
        }),
    );
    const [request, url] = req(
      "https://plugins.elizacloud.ai/generated-registry.json",
    );
    const response = await serveRegistryHostRequest(request, url, ENV);
    expect(response?.status).toBe(200);
    expect(response?.headers.get("content-type")).toBe(
      "application/json; charset=utf-8",
    );
    expect(response?.headers.get("access-control-allow-origin")).toBe("*");
    expect(response?.headers.get("cache-control")).toContain("max-age=");
    expect(await response?.text()).toBe('{"registry":true}');
    expect(calls[0]).toContain(
      "raw.githubusercontent.com/elizaOS/eliza/develop/packages/registry/generated-registry.json",
    );
  });

  test("serves the staging host from the same allowlist", async () => {
    stubUpstream(() => new Response("{}", { status: 200 }));
    const [request, url] = req(
      "https://plugins.staging.elizacloud.ai/generated-registry.json",
    );
    const response = await serveRegistryHostRequest(request, url, ENV);
    expect(response?.status).toBe(200);
  });

  test("404s paths outside the artifact allowlist without touching upstream", async () => {
    const { calls } = stubUpstream(() => new Response("{}"));
    const [request, url] = req("https://plugins.elizacloud.ai/secrets.json");
    const response = await serveRegistryHostRequest(request, url, ENV);
    expect(response?.status).toBe(404);
    const body = (await response?.json()) as { code?: string };
    expect(body?.code).toBe("resource_not_found");
    expect(calls).toHaveLength(0);
  });

  test("fails closed on an upstream error instead of leaking it", async () => {
    stubUpstream(() => new Response("upstream boom", { status: 500 }));
    const [request, url] = req(
      "https://plugins.elizacloud.ai/generated-registry.json",
    );
    const response = await serveRegistryHostRequest(request, url, ENV);
    expect(response?.status).toBe(404);
    const body = (await response?.json()) as { code?: string };
    expect(body?.code).toBe("resource_not_found");
  });

  test("rejects writes with 405", async () => {
    stubUpstream(() => new Response("{}"));
    const [request, url] = req(
      "https://plugins.elizacloud.ai/generated-registry.json",
      "POST",
    );
    const response = await serveRegistryHostRequest(request, url, ENV);
    expect(response?.status).toBe(405);
    expect(response?.headers.get("allow")).toBe("GET, HEAD");
  });

  test("HEAD returns headers with an empty body", async () => {
    stubUpstream(() => new Response("{}", { status: 200 }));
    const [request, url] = req(
      "https://plugins.elizacloud.ai/generated-registry.json",
      "HEAD",
    );
    const response = await serveRegistryHostRequest(request, url, ENV);
    expect(response?.status).toBe(200);
    expect(await response?.text()).toBe("");
  });

  test("honours a configured base domain", async () => {
    stubUpstream(() => new Response("{}", { status: 200 }));
    const [request, url] = req(
      "https://plugins.example.dev/generated-registry.json",
    );
    const response = await serveRegistryHostRequest(request, url, {
      ELIZA_CLOUD_AGENT_BASE_DOMAIN: "example.dev",
    } as typeof ENV);
    expect(response?.status).toBe(200);
  });
});
