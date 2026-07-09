/**
 * Keyless per-plugin e2e for `@elizaos/plugin-elizacloud` (issue #8801, cluster
 * 1 of #15759).
 *
 * Drives the `CLOUD_ACCOUNT_STATUS` action end-to-end against a scoped mock of
 * the Eliza Cloud HTTP API, installed via a fetch interceptor in the seed. The
 * real CloudAuthService authenticates from a seeded `ELIZAOS_CLOUD_API_KEY`
 * (isAuthenticated → true, so the action's validate offers it to the planner),
 * and the handler reads `GET /credits/balance` through the typed SDK — a public
 * account read that needs no live cloud. `ELIZAOS_CLOUD_USE_INFERENCE` /
 * `_USE_EMBEDDINGS` are pinned off so the cloud plugin never steals the
 * deterministic proxy's text/embedding slots, and every other cloud service's
 * startup read (containers, model registry, gateway relay, key re-validation)
 * is answered by the same mock so the plugin boots fully offline.
 */
import type { AgentRuntime } from "@elizaos/core";
import { ModelType } from "@elizaos/core";
import { scenario } from "@elizaos/scenario-runner/schema";
import {
  describeCalls,
  successfulActionData,
} from "../_helpers/effect-assertions.ts";

const CLOUD_ACCOUNT_STATUS = "CLOUD_ACCOUNT_STATUS";
const CLOUD_BASE_URL = "https://cloud.test.invalid/api/v1";
const MOCK_BALANCE = 12.5;

type R = AgentRuntime & {
  setSetting?: (k: string, v: string, secret?: boolean) => void;
  scenarioLlmFixtures?: {
    register: (...f: Array<Record<string, unknown>>) => void;
  };
};

let restoreFetch: (() => void) | undefined;
/** True once the balance endpoint was actually served by the mock. */
let balanceMockHit = false;

export default scenario({
  lane: "pr-deterministic",
  id: "elizacloud.account-status",
  title: "Eliza Cloud: read credit balance against a mocked cloud API",
  domain: "elizacloud",
  tags: ["smoke", "elizacloud", "cloud"],
  description:
    "Reads the Eliza Cloud credit balance through the CLOUD_ACCOUNT_STATUS action against a scoped mock of the cloud HTTP API — keyless, no live cloud account.",

  requires: { plugins: ["@elizaos/plugin-elizacloud"] },
  isolation: "per-scenario",

  seed: [
    {
      type: "custom",
      name: "elizacloud-mock-and-config",
      apply: async (ctx) => {
        const runtime = ctx.runtime as R;
        balanceMockHit = false;

        const realFetch = globalThis.fetch;
        restoreFetch = () => {
          if (globalThis.fetch === cloudMockFetch) {
            globalThis.fetch = realFetch;
          }
          restoreFetch = undefined;
        };
        const cloudMockFetch = (async (
          input: RequestInfo | URL,
          init?: RequestInit,
        ) => {
          const url =
            typeof input === "string"
              ? input
              : input instanceof Request
                ? input.url
                : input.toString();
          if (url.includes("cloud.test.invalid")) {
            if (/\/credits\/balance/.test(url)) {
              balanceMockHit = true;
              return new Response(JSON.stringify({ balance: MOCK_BALANCE }), {
                headers: { "Content-Type": "application/json" },
              });
            }
            // Every other cloud read at plugin start (model registry + auth
            // probe /models, container list, gateway-relay register) gets a
            // benign empty payload so the plugin boots fully offline.
            return new Response(JSON.stringify({ data: [] }), {
              headers: { "Content-Type": "application/json" },
            });
          }
          return realFetch(input, init);
        }) as typeof fetch;
        globalThis.fetch = cloudMockFetch;

        // Authenticate CloudAuth from a saved key, pin the base URL at the
        // mock host, and keep the cloud plugin from claiming the chat-brain /
        // embedding model slots the deterministic proxy owns.
        runtime.setSetting?.(
          "ELIZAOS_CLOUD_API_KEY",
          "cloud_scenario_key",
          true,
        );
        runtime.setSetting?.("ELIZAOS_CLOUD_BASE_URL", CLOUD_BASE_URL);
        runtime.setSetting?.("ELIZAOS_CLOUD_USE_INFERENCE", "false");
        runtime.setSetting?.("ELIZAOS_CLOUD_USE_EMBEDDINGS", "false");
        process.env.ELIZAOS_CLOUD_API_KEY = "cloud_scenario_key";
        process.env.ELIZAOS_CLOUD_BASE_URL = CLOUD_BASE_URL;
        process.env.ELIZAOS_CLOUD_USE_INFERENCE = "false";
        process.env.ELIZAOS_CLOUD_USE_EMBEDDINGS = "false";

        runtime.scenarioLlmFixtures?.register(
          {
            name: "elizacloud-stage1",
            match: {
              modelType: ModelType.RESPONSE_HANDLER,
              input: (v: string) => v.includes("credit") || v.includes("cloud"),
              toolName: "HANDLE_RESPONSE",
            },
            response: {
              contexts: ["cloud", "finance"],
              intents: ["check my cloud credits"],
              replyText: "",
              threadOps: [],
              candidateActionNames: [CLOUD_ACCOUNT_STATUS],
            },
            times: 1,
          },
          {
            name: "elizacloud-planner",
            match: (call: { modelType: string; toolNames: string[] }) =>
              call.modelType === ModelType.ACTION_PLANNER &&
              call.toolNames.includes(CLOUD_ACCOUNT_STATUS),
            response: {
              text: "",
              thought: "Check the Eliza Cloud credit balance.",
              messageToUser: "",
              completed: true,
              finishReason: "tool-calls",
              toolCalls: [
                {
                  id: "call-cloud",
                  name: CLOUD_ACCOUNT_STATUS,
                  type: "function",
                  arguments: {},
                },
              ],
            },
            times: 1,
          },
          {
            name: "elizacloud-decision",
            match: (call: { modelType: string; toolNames: string[] }) =>
              call.modelType === ModelType.RESPONSE_HANDLER &&
              !call.toolNames.includes("HANDLE_RESPONSE"),
            response: {
              success: true,
              decision: "FINISH",
              thought: "Reported the cloud balance; nothing more to do.",
              messageToUser: "Here's your Eliza Cloud balance.",
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
      name: "restore-elizacloud-fetch",
      apply: () => {
        restoreFetch?.();
        return undefined;
      },
    },
  ],

  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Eliza Cloud",
    },
  ],

  turns: [
    {
      kind: "message",
      name: "balance",
      text: "How many Eliza Cloud credits do I have left?",
      timeoutMs: 120_000,
      assertTurn: (turn) => {
        const call = turn.actionsCalled.find(
          (a) => a.actionName === CLOUD_ACCOUNT_STATUS,
        );
        if (!call) {
          return `Expected ${CLOUD_ACCOUNT_STATUS} but got: ${turn.actionsCalled
            .map((a) => a.actionName)
            .join(", ")}`;
        }
        if (!call.result?.success) {
          return `${CLOUD_ACCOUNT_STATUS} did not succeed: ${
            call.error?.message ?? call.result?.text ?? "unknown error"
          }`;
        }
      },
    },
  ],

  finalChecks: [
    {
      type: "actionCalled",
      actionName: CLOUD_ACCOUNT_STATUS,
      status: "success",
      minCount: 1,
    },
    {
      // Effect proof (#11381): the read really hit the cloud balance endpoint
      // and surfaced the mock's balance in the action result — not just "the
      // handler returned success".
      type: "custom",
      name: "elizacloud-balance-effect",
      predicate: (ctx) => {
        if (!balanceMockHit) {
          return "cloud mock never served /credits/balance — the balance read never touched the HTTP path";
        }
        const data = successfulActionData(ctx, CLOUD_ACCOUNT_STATUS);
        if (!data) {
          return `no successful ${CLOUD_ACCOUNT_STATUS} result data; calls: ${describeCalls(ctx)}`;
        }
        if (data.balance !== MOCK_BALANCE) {
          return `expected result.data.balance ${MOCK_BALANCE} from the mock, saw ${String(data.balance ?? "(missing)")}`;
        }
        if (typeof data.topUpUrl !== "string" || data.topUpUrl.length === 0) {
          return `expected a top-up URL in result.data.topUpUrl, saw ${JSON.stringify(data.topUpUrl ?? null)}`;
        }
      },
    },
  ],
});
