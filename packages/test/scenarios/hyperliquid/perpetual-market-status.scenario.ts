/**
 * Keyless per-plugin e2e for `@elizaos/plugin-hyperliquid` (issue #8801).
 *
 * Drives the `PERPETUAL_MARKET` action's read/status op end-to-end against a
 * scoped mock of the desktop Hyperliquid bridge endpoint
 * (`/api/hyperliquid/status`), installed via a fetch interceptor in the seed.
 * Status is a public read (no wallet, no signer, no credentials), so this
 * exercises the real action → service → HTTP path with zero secrets. The action
 * makes no model calls, so only routing fixtures are needed.
 */
import type { AgentRuntime } from "@elizaos/core";
import { ModelType } from "@elizaos/core";
import { scenario } from "@elizaos/scenario-runner/schema";

const PERPETUAL_MARKET = "PERPETUAL_MARKET";
type R = AgentRuntime & {
  scenarioLlmFixtures?: {
    register: (...f: Array<Record<string, unknown>>) => void;
  };
};

const STATUS_RESPONSE = {
  publicReadReady: true,
  signerReady: false,
  executionReady: false,
  executionBlockedReason: "Order placement is disabled in this read-only app.",
  accountAddress: null,
  apiBaseUrl: "https://api.hyperliquid.xyz",
  credentialMode: "none",
  readiness: {
    publicReads: true,
    accountReads: false,
    signer: false,
    execution: false,
  },
  account: { address: null, source: "none", guidance: null },
  vault: { configured: false, ready: false, address: null, guidance: "" },
  apiWallet: { configured: false, guidance: "" },
};

export default scenario({
  lane: "pr-deterministic",
  id: "hyperliquid.perpetual-market-status",
  title: "Hyperliquid: read perpetual market status against a mocked bridge",
  domain: "hyperliquid",
  tags: ["smoke", "hyperliquid", "connector"],
  description:
    "Reads Hyperliquid public market status through the PERPETUAL_MARKET action against a scoped mock of the desktop bridge endpoint — keyless, no wallet.",

  requires: { plugins: ["@elizaos/plugin-hyperliquid"] },
  isolation: "per-scenario",

  seed: [
    {
      type: "custom",
      name: "hyperliquid-bridge-mock",
      apply: async (ctx) => {
        const runtime = ctx.runtime as R;
        const realFetch = globalThis.fetch;
        globalThis.fetch = (async (
          input: RequestInfo | URL,
          init?: RequestInit,
        ) => {
          const url = typeof input === "string" ? input : input.toString();
          if (url.includes("/api/hyperliquid/status")) {
            return new Response(JSON.stringify(STATUS_RESPONSE), {
              headers: { "Content-Type": "application/json" },
            });
          }
          return realFetch(input, init);
        }) as typeof fetch;

        runtime.scenarioLlmFixtures?.register(
          {
            name: "hyperliquid-stage1",
            match: {
              modelType: ModelType.RESPONSE_HANDLER,
              input: (v: string) => v.includes("Hyperliquid"),
              toolName: "HANDLE_RESPONSE",
            },
            response: {
              contexts: ["connectors"],
              intents: ["read hyperliquid status"],
              replyText: "",
              threadOps: [],
              candidateActionNames: [PERPETUAL_MARKET],
            },
            times: 1,
          },
          {
            name: "hyperliquid-planner",
            match: {
              modelType: ModelType.ACTION_PLANNER,
              input: (v: string) => v.includes("Hyperliquid"),
              toolName: PERPETUAL_MARKET,
            },
            response: {
              text: "",
              thought: "Read Hyperliquid market status.",
              messageToUser: "",
              completed: true,
              finishReason: "tool-calls",
              toolCalls: [
                {
                  id: "call-hl",
                  name: PERPETUAL_MARKET,
                  type: "function",
                  arguments: {
                    target: "hyperliquid",
                    action: "read",
                    kind: "status",
                  },
                },
              ],
            },
            times: 1,
          },
          {
            name: "hyperliquid-decision",
            match: (call: { modelType: string; toolNames: string[] }) =>
              call.modelType === ModelType.RESPONSE_HANDLER &&
              !call.toolNames.includes("HANDLE_RESPONSE"),
            response: {
              success: true,
              decision: "FINISH",
              thought: "Reported Hyperliquid status; nothing more to do.",
              messageToUser: "Hyperliquid public reads are ready.",
            },
            times: 1,
          },
        );
        return undefined;
      },
    },
  ],

  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Hyperliquid",
    },
  ],

  turns: [
    {
      kind: "message",
      name: "status",
      text: "Show me the Hyperliquid perpetual market status.",
      timeoutMs: 120_000,
      assertTurn: (turn) => {
        const call = turn.actionsCalled.find(
          (a) => a.actionName === PERPETUAL_MARKET,
        );
        if (!call) {
          return `Expected ${PERPETUAL_MARKET} but got: ${turn.actionsCalled
            .map((a) => a.actionName)
            .join(", ")}`;
        }
        if (!call.result?.success) {
          return `${PERPETUAL_MARKET} did not succeed: ${
            call.error?.message ?? call.result?.text ?? "unknown error"
          }`;
        }
      },
    },
  ],

  finalChecks: [
    {
      type: "actionCalled",
      actionName: PERPETUAL_MARKET,
      status: "success",
      minCount: 1,
    },
  ],
});
