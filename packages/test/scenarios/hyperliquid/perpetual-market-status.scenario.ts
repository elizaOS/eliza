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
import {
  describeCalls,
  successfulActionData,
  toRecord,
} from "../_helpers/effect-assertions.ts";

const PERPETUAL_MARKET = "PERPETUAL_MARKET";
type R = AgentRuntime & {
  scenarioLlmFixtures?: {
    register: (...f: Array<Record<string, unknown>>) => void;
  };
};

let restoreFetch: (() => void) | undefined;
/** Number of /api/hyperliquid/status reads the bridge mock actually served. */
let statusMockHits = 0;

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
        statusMockHits = 0;
        const realFetch = globalThis.fetch;
        restoreFetch = () => {
          if (globalThis.fetch === hyperliquidMockFetch) {
            globalThis.fetch = realFetch;
          }
          restoreFetch = undefined;
        };
        const hyperliquidMockFetch = (async (
          input: RequestInfo | URL,
          init?: RequestInit,
        ) => {
          const url =
            typeof input === "string"
              ? input
              : input instanceof Request
                ? input.url
                : input.toString();
          if (url.includes("/api/hyperliquid/status")) {
            statusMockHits += 1;
            return new Response(JSON.stringify(STATUS_RESPONSE), {
              headers: { "Content-Type": "application/json" },
            });
          }
          return realFetch(input, init);
        }) as typeof fetch;
        globalThis.fetch = hyperliquidMockFetch;

        runtime.scenarioLlmFixtures?.register(
          {
            name: "hyperliquid-stage1",
            match: {
              modelType: ModelType.RESPONSE_HANDLER,
              input: (v: string) => v.includes("Hyperliquid"),
              toolName: "HANDLE_RESPONSE",
            },
            response: {
              contexts: ["finance", "connectors"],
              intents: ["read hyperliquid status"],
              replyText: "",
              threadOps: [],
              candidateActionNames: [PERPETUAL_MARKET],
            },
            times: 1,
          },
          {
            name: "hyperliquid-planner",
            match: (call: { modelType: string; toolNames: string[] }) =>
              call.modelType === ModelType.ACTION_PLANNER &&
              call.toolNames.includes(PERPETUAL_MARKET),
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
  cleanup: [
    {
      type: "custom",
      name: "restore-hyperliquid-fetch",
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
    {
      // Effect proof (#11381): the read really hit the bridge's status
      // endpoint and surfaced the mock's readiness payload (public reads
      // ready, keyless credential mode) in the action result — not just
      // "the handler returned success".
      type: "custom",
      name: "hyperliquid-status-effect",
      predicate: (ctx) => {
        if (statusMockHits === 0) {
          return "bridge mock never served /api/hyperliquid/status — the status read never touched the HTTP path";
        }
        const data = successfulActionData(ctx, PERPETUAL_MARKET);
        if (!data) {
          return `no successful ${PERPETUAL_MARKET} result data; calls: ${describeCalls(ctx)}`;
        }
        if (data.kind !== "status") {
          return `expected result.data.kind "status", saw ${String(data.kind ?? "(missing)")}`;
        }
        const status = toRecord(data.status);
        if (!status) {
          return `expected result.data.status payload from the bridge, saw ${JSON.stringify(data).slice(0, 300)}`;
        }
        if (
          status.publicReadReady !== true ||
          status.credentialMode !== "none" ||
          status.executionReady !== false
        ) {
          return `expected the mock's readiness (publicReadReady=true, credentialMode="none", executionReady=false); saw ${JSON.stringify(status).slice(0, 300)}`;
        }
      },
    },
  ],
});
