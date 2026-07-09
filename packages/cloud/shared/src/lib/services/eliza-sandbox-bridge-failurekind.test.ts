/**
 * The bridge `message.send` ladder must propagate the runtime's `failureKind`
 * discriminator and tag which rung replied (#15616).
 *
 * The agent runtime answers HTTP 200 with canned text plus `failureKind` when
 * its model path is dead; the bridge used to extract only `text`, so its
 * `fallback: true` fabrication flag never fired and e2e chat checks passed on
 * canned failures. Both ladder implementations (the standalone bridge service
 * and the duplicate on the host service — the one production `bridge()` runs)
 * must now surface `failureKind` and a `transport` tag, while KEEPING the
 * text-short-circuit semantics: a canned failure reply still ends the ladder
 * so gateway/REST consumers deliver the designed failure text instead of the
 * fabricated generic fallback. Real ladder methods; only the sandbox-side HTTP
 * boundary (fetch) is stubbed.
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import type { AgentSandbox } from "../../db/repositories/agent-sandboxes";
import { logger } from "../utils/logger";
import { ElizaSandboxService } from "./eliza-sandbox";
import type { BridgeRequest, BridgeResponse } from "./eliza-sandbox-bridge";
import { ElizaSandboxBridgeService } from "./eliza-sandbox-bridge";

type MessageSender = {
  bridgeMessageSend(rec: AgentSandbox, rpc: BridgeRequest): Promise<BridgeResponse>;
};

const rec = {
  id: "sandbox-1",
  bridge_url: "http://sandbox.test",
  environment_vars: {},
} as unknown as AgentSandbox;

const rpc: BridgeRequest = {
  jsonrpc: "2.0",
  id: "test-1",
  method: "message.send",
  params: {
    text: "Reply with one short sentence that contains the token pong-123.",
    roomId: "room-1",
  },
};

const endpointStubs = {
  getAgentApiEndpoint: async (_rec: unknown, path: string) => `http://sandbox.test${path}`,
  getAgentJsonHeaders: () => ({ "content-type": "application/json" }),
  ensureRuntimeAgentStarted: async () => ({ id: "runtime-agent-1", name: "Smoke" }),
};

// The host service's ladder duplicate is what production bridge() dispatches
// to; shadow its private endpoint helpers so no tailnet lookup happens.
const senders: Array<[string, () => MessageSender]> = [
  [
    "ElizaSandboxBridgeService",
    () => new ElizaSandboxBridgeService(endpointStubs as never) as unknown as MessageSender,
  ],
  [
    "ElizaSandboxService",
    () => {
      const hostService = new ElizaSandboxService() as unknown as MessageSender &
        Record<string, unknown>;
      Object.assign(hostService, endpointStubs);
      return hostService;
    },
  ],
];

function makeHostServiceSender(): MessageSender {
  const hostService = new ElizaSandboxService() as unknown as MessageSender &
    Record<string, unknown>;
  Object.assign(hostService, endpointStubs);
  return hostService;
}

/**
 * Stub the sandbox HTTP surface: the native /bridge and every REST rung except
 * the conversation route 404 (legacy-image shape), the conversation route
 * returns `messageBody`. Records every requested path for ladder assertions.
 */
function installFetchStub(messageBody: Record<string, unknown>): string[] {
  const paths: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const path = new URL(url).pathname;
    paths.push(path);
    if (path === "/api/conversations") {
      return Response.json({ conversation: { id: "conv-1" } });
    }
    if (path === "/api/conversations/conv-1/messages") {
      return Response.json(messageBody);
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return paths;
}

/**
 * Stub the production host-service first rung: the cloud-agent image's native
 * JSON-RPC `/bridge` endpoint. This is the path the Hetzner nightly hits on
 * current cloud-agent images, so failure discriminators must not rely on the
 * later conversation REST rung to be observable.
 */
function installNativeBridgeFetchStub(result: Record<string, unknown>): string[] {
  const paths: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const path = new URL(url).pathname;
    paths.push(path);
    if (path === "/bridge") {
      return Response.json({
        jsonrpc: "2.0",
        id: rpc.id,
        result,
      });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return paths;
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("ElizaSandboxService native bridge failureKind propagation", () => {
  test("native JSON-RPC canned failure reply carries failureKind and ends the ladder", async () => {
    const paths = installNativeBridgeFetchStub({
      text: "Sorry, I'm having a provider issue",
      failureKind: "provider_issue",
    });

    const response = await makeHostServiceSender().bridgeMessageSend(rec, rpc);

    expect(response.error).toBeUndefined();
    expect(response.result?.text).toBe("Sorry, I'm having a provider issue");
    expect(response.result?.failureKind).toBe("provider_issue");
    expect(response.result?.transport).toBe("native-jsonrpc");
    expect(response.result?.fallback).toBeUndefined();
    expect(paths).toEqual(["/bridge"]);
  });

  test("malformed native JSON-RPC body is logged before the ladder falls through", async () => {
    const warnSpy = spyOn(logger, "warn").mockImplementation(() => {});
    const paths: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const path = new URL(url).pathname;
      paths.push(path);
      if (path === "/bridge") {
        return {
          status: 502,
          json: async () => {
            throw new Error("invalid json");
          },
        } as Response;
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    try {
      const response = await makeHostServiceSender().bridgeMessageSend(rec, rpc);

      expect(response.result?.fallback).toBe(true);
      expect(response.result?.transport).toBe("fallback");
      expect(paths).toContain("/bridge");
      expect(warnSpy).toHaveBeenCalledWith(
        "[agent-sandbox] Failed to parse native bridge JSON-RPC body",
        expect.objectContaining({
          agentId: "sandbox-1",
          status: 502,
          error: "invalid json",
        }),
      );
    } finally {
      warnSpy.mockRestore();
    }
  });
});

for (const [label, make] of senders) {
  describe(`${label}.bridgeMessageSend failureKind propagation`, () => {
    test("canned failure reply keeps its text, carries failureKind, and still ends the ladder", async () => {
      const paths = installFetchStub({
        text: "Sorry, I'm having a provider issue",
        agentName: "Smoke",
        failureKind: "provider_issue",
      });

      const response = await make().bridgeMessageSend(rec, rpc);

      expect(response.error).toBeUndefined();
      expect(response.result?.text).toBe("Sorry, I'm having a provider issue");
      expect(response.result?.failureKind).toBe("provider_issue");
      expect(response.result?.transport).toBe("conversation-rest");
      // NOT the bridge's own fabrication — the runtime really replied.
      expect(response.result?.fallback).toBeUndefined();
      // Production semantics kept: the canned text short-circuits the ladder,
      // so the slower OpenAI-compat / central-channel rungs never fire.
      expect(paths).not.toContain("/v1/chat/completions");
      expect(paths.some((p) => p.startsWith("/api/messaging/central-channels/"))).toBe(false);
    });

    test("genuine reply is unchanged apart from the additive transport tag", async () => {
      installFetchStub({
        text: "Sure — the token is pong-123.",
        agentName: "Smoke",
      });

      const response = await make().bridgeMessageSend(rec, rpc);

      expect(response.result?.text).toBe("Sure — the token is pong-123.");
      expect(response.result?.failureKind).toBeUndefined();
      expect(response.result?.fallback).toBeUndefined();
      expect(response.result?.transport).toBe("conversation-rest");
    });

    test("empty reply still falls through the ladder into the flagged fabrication", async () => {
      const paths = installFetchStub({ text: "" });

      const response = await make().bridgeMessageSend(rec, rpc);

      // Every rung came up empty, so the bridge fabricates — and says so.
      expect(response.result?.fallback).toBe(true);
      expect(response.result?.reason).toBe("agent_no_reply");
      expect(response.result?.transport).toBe("fallback");
      expect(paths).toContain("/v1/chat/completions");
    });
  });
}
