/**
 * Keyless per-plugin e2e for `@elizaos/plugin-nostr` (issue #8801).
 *
 * plugin-nostr ships no planner actions of its own: it registers a Nostr POST
 * connector (publish / fetch-feed / NIP-50 search) and a Nostr DM message
 * connector at service start. The agent reaches that surface through the core
 * `POST` action, which routes `action=search`, `source=nostr` to the connector's
 * `searchPosts` hook.
 *
 * To run this keyless and offline we:
 *   1. Seed a deterministic Nostr identity (a fixed valid secp256k1 hex key and
 *      a single relay) BEFORE the plugin is registered, so the service starts,
 *      derives a pubkey, and registers its connectors.
 *   2. Replace `globalThis.WebSocket` with an in-process mock relay that answers
 *      every REQ subscription with an immediate EOSE (zero events). nostr-tools'
 *      `SimplePool.querySync` then resolves instantly with an empty result — no
 *      network, no credentials, fully deterministic.
 *
 * A "search nostr" request routes POST → the Nostr post connector → the mock
 * relay, and the action reports zero posts found.
 */
import type { AgentRuntime } from "@elizaos/core";
import { ModelType } from "@elizaos/core";
import { scenario } from "@elizaos/scenario-runner/schema";
import {
  describeCalls,
  successfulActionData,
} from "../_helpers/effect-assertions.ts";

const POST = "POST";

// A fixed, valid secp256k1 private key (scalar = 1) — deterministic, keyless.
const NOSTR_TEST_PRIVATE_KEY =
  "0000000000000000000000000000000000000000000000000000000000000001";
const NOSTR_TEST_RELAY = "wss://relay.test.invalid";

type R = AgentRuntime & {
  setSetting?: (k: string, v: string) => void;
  scenarioLlmFixtures?: {
    register: (...f: Array<Record<string, unknown>>) => void;
  };
};

let restoreWebSocket: (() => void) | undefined;
/** REQ subscriptions the mock relay actually answered with EOSE. */
let relayReqSubscriptions: string[] = [];

/**
 * Minimal in-process Nostr relay over the WebSocket interface nostr-tools uses
 * (`new WebSocket(url)` + onopen/onmessage/onclose/onerror + send/close). It
 * answers REQ with EOSE (no events) and EVENT with OK so any query/publish
 * resolves immediately without touching the network.
 */
class MockRelayWebSocket {
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  readyState = 0;
  url: string;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: ((ev: { code?: number; reason?: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    setTimeout(() => {
      this.readyState = MockRelayWebSocket.OPEN;
      this.onopen?.();
    }, 0);
  }

  send(data: string): void {
    let message: unknown;
    try {
      message = JSON.parse(data);
    } catch {
      return;
    }
    if (!Array.isArray(message)) return;
    const [type, sub] = message as [string, string, ...unknown[]];
    if (type === "REQ") {
      relayReqSubscriptions.push(sub);
      setTimeout(() => {
        this.onmessage?.({ data: JSON.stringify(["EOSE", sub]) });
      }, 0);
    } else if (type === "EVENT") {
      const event = (message as [string, { id?: string }])[1];
      setTimeout(() => {
        this.onmessage?.({
          data: JSON.stringify(["OK", event?.id ?? "", true, ""]),
        });
      }, 0);
    } else if (type === "COUNT") {
      setTimeout(() => {
        this.onmessage?.({
          data: JSON.stringify(["COUNT", sub, { count: 0 }]),
        });
      }, 0);
    }
  }

  close(): void {
    this.readyState = MockRelayWebSocket.CLOSED;
    this.onclose?.({ code: 1000, reason: "" });
  }
}

export default scenario({
  lane: "pr-deterministic",
  id: "nostr.search-posts",
  title: "Nostr: search public notes through the POST connector",
  domain: "nostr",
  tags: ["smoke", "nostr", "connector"],
  description:
    "Searches Nostr public notes via the core POST action routed to the plugin-nostr post connector, backed by an in-process mock relay — keyless, no live relay or private key from the network.",

  requires: { plugins: ["@elizaos/plugin-nostr"] },
  isolation: "per-scenario",

  seed: [
    {
      type: "custom",
      name: "nostr-mock-relay-and-config",
      apply: async (ctx) => {
        const runtime = ctx.runtime as R;
        relayReqSubscriptions = [];

        // Install the mock relay transport BEFORE plugin-nostr registers, so
        // SimplePool (constructed at service start) captures it as its
        // WebSocket implementation.
        const realWebSocket = globalThis.WebSocket;
        restoreWebSocket = () => {
          if (
            (globalThis as { WebSocket?: unknown }).WebSocket ===
            (MockRelayWebSocket as unknown)
          ) {
            (globalThis as { WebSocket?: unknown }).WebSocket = realWebSocket;
          }
          restoreWebSocket = undefined;
        };
        (globalThis as { WebSocket?: unknown }).WebSocket =
          MockRelayWebSocket as unknown;

        // Seed a deterministic Nostr identity so the service starts and
        // registers its post + DM connectors.
        process.env.NOSTR_PRIVATE_KEY = NOSTR_TEST_PRIVATE_KEY;
        process.env.NOSTR_RELAYS = NOSTR_TEST_RELAY;
        process.env.NOSTR_DM_POLICY = "pairing";
        runtime.setSetting?.("NOSTR_PRIVATE_KEY", NOSTR_TEST_PRIVATE_KEY);
        runtime.setSetting?.("NOSTR_RELAYS", NOSTR_TEST_RELAY);
        runtime.setSetting?.("NOSTR_DM_POLICY", "pairing");

        runtime.scenarioLlmFixtures?.register(
          {
            name: "nostr-stage1",
            match: {
              modelType: ModelType.RESPONSE_HANDLER,
              input: (v: string) => v.includes("Nostr"),
              toolName: "HANDLE_RESPONSE",
            },
            response: {
              contexts: ["connectors"],
              intents: ["nostr"],
              replyText: "",
              threadOps: [],
              candidateActionNames: [POST],
            },
            times: 1,
          },
          {
            name: "nostr-planner",
            match: {
              modelType: ModelType.ACTION_PLANNER,
              input: (v: string) => v.includes("Nostr"),
              toolName: POST,
            },
            response: {
              text: "",
              thought: "Search Nostr public notes.",
              messageToUser: "",
              completed: true,
              finishReason: "tool-calls",
              toolCalls: [
                {
                  id: "call-nostr",
                  name: POST,
                  type: "function",
                  arguments: {
                    action: "search",
                    source: "nostr",
                    query: "elizaos",
                  },
                },
              ],
            },
            times: 1,
          },
          {
            name: "nostr-decision",
            match: (call: { modelType: string; toolNames: string[] }) =>
              call.modelType === ModelType.RESPONSE_HANDLER &&
              !call.toolNames.includes("HANDLE_RESPONSE"),
            response: {
              success: true,
              decision: "FINISH",
              thought: "Nostr search returned no posts; nothing more to do.",
              messageToUser: "No Nostr posts found for that search.",
            },
            times: 1,
          },
        );
        return undefined;
      },
    },
  ],
  cleanup: [
    {
      type: "custom",
      name: "restore-nostr-websocket",
      apply: () => {
        restoreWebSocket?.();
        return undefined;
      },
    },
  ],

  rooms: [
    { id: "main", source: "dashboard", channelType: "DM", title: "Nostr" },
  ],

  turns: [
    {
      kind: "message",
      name: "search",
      text: "Search Nostr for posts about elizaos.",
      timeoutMs: 120_000,
      assertTurn: (turn) => {
        const call = turn.actionsCalled.find((a) => a.actionName === POST);
        if (!call) {
          return `Expected ${POST} but got: ${turn.actionsCalled
            .map((a) => a.actionName)
            .join(", ")}`;
        }
        if (!call.result?.success) {
          return `${POST} did not succeed: ${
            call.error?.message ?? call.result?.text ?? "unknown error"
          }`;
        }
      },
    },
  ],

  finalChecks: [
    {
      type: "actionCalled",
      actionName: POST,
      status: "success",
      minCount: 1,
    },
    {
      // Effect proof (#11381): the search really flowed POST → nostr post
      // connector → mock relay (a REQ subscription was answered) and the
      // action surfaced the relay's empty result for the requested query —
      // not just "the handler returned success".
      type: "custom",
      name: "nostr-search-effect",
      predicate: (ctx) => {
        if (relayReqSubscriptions.length === 0) {
          return "mock relay never received a REQ subscription — the search never touched the Nostr transport";
        }
        const data = successfulActionData(ctx, POST);
        if (!data) {
          return `no successful ${POST} result data; calls: ${describeCalls(ctx)}`;
        }
        if (data.op !== "search" || data.source !== "nostr") {
          return `expected result.data op "search" on source "nostr", saw op=${String(data.op)} source=${String(data.source)}`;
        }
        if (data.query !== "elizaos") {
          return `expected the searched query "elizaos" in result.data.query, saw ${JSON.stringify(data.query ?? null)}`;
        }
        if (!Array.isArray(data.posts) || data.posts.length !== 0) {
          return `mock relay returns zero events, so result.data.posts must be an empty array; saw ${JSON.stringify(data.posts ?? null).slice(0, 200)}`;
        }
      },
    },
  ],
});
