/**
 * Keyless per-plugin e2e for `@elizaos/plugin-linear` (issue #8801).
 *
 * Exercises the LINEAR connector end-to-end against a scoped mock of the Linear
 * GraphQL API (api.linear.app), installed via a fetch interceptor in the seed so
 * the @linear/sdk client is transparently redirected — no live workspace or
 * credentials. A "search issues" request routes through the LINEAR action,
 * which queries the mock (empty result) and reports no issues found.
 */
import type { AgentRuntime } from "@elizaos/core";
import { ModelType } from "@elizaos/core";
import { scenario } from "@elizaos/scenario-runner/schema";
import {
  describeCalls,
  successfulActionData,
} from "../_helpers/effect-assertions.ts";

const LINEAR = "LINEAR";
type R = AgentRuntime & {
  setSetting?: (k: string, v: string) => void;
  scenarioLlmFixtures?: {
    register: (...f: Array<Record<string, unknown>>) => void;
  };
};

let restoreFetch: (() => void) | undefined;
/** GraphQL queries the Linear API mock actually served. */
let linearMockQueries: string[] = [];

export default scenario({
  lane: "pr-deterministic",
  id: "linear.search-issues",
  title: "Linear: search issues against a mocked GraphQL API",
  domain: "linear",
  tags: ["smoke", "linear", "connector"],
  description:
    "Searches Linear issues through the LINEAR action against a scoped mock of the Linear GraphQL API — keyless, no live workspace.",

  requires: { plugins: ["@elizaos/plugin-linear"] },
  isolation: "per-scenario",

  seed: [
    {
      type: "custom",
      name: "linear-mock-and-config",
      apply: async (ctx) => {
        const runtime = ctx.runtime as R;
        linearMockQueries = [];
        // Scoped fetch interceptor: redirect @linear/sdk's calls to a mock.
        const realFetch = globalThis.fetch;
        restoreFetch = () => {
          if (globalThis.fetch === linearMockFetch) {
            globalThis.fetch = realFetch;
          }
          restoreFetch = undefined;
        };
        const linearMockFetch = (async (
          input: RequestInfo | URL,
          init?: RequestInit,
        ) => {
          const url =
            typeof input === "string"
              ? input
              : input instanceof Request
                ? input.url
                : input.toString();
          if (url.includes("api.linear.app")) {
            let query = "";
            try {
              query = JSON.parse(String(init?.body ?? "{}")).query ?? "";
            } catch {}
            linearMockQueries.push(query);
            const data: Record<string, unknown> = {};
            if (/issues/i.test(query)) {
              data.issues = {
                nodes: [],
                pageInfo: { hasNextPage: false, endCursor: null },
              };
            }
            if (/viewer/i.test(query)) {
              data.viewer = { id: "u1", name: "Test", email: "t@example.com" };
            }
            if (/teams/i.test(query)) {
              data.teams = { nodes: [], pageInfo: { hasNextPage: false } };
            }
            return new Response(JSON.stringify({ data }), {
              headers: { "Content-Type": "application/json" },
            });
          }
          return realFetch(input, init);
        }) as typeof fetch;
        globalThis.fetch = linearMockFetch;

        process.env.LINEAR_API_KEY = "lin_api_test_dummy";
        runtime.setSetting?.("LINEAR_API_KEY", "lin_api_test_dummy");

        runtime.scenarioLlmFixtures?.register(
          {
            name: "linear-stage1",
            match: {
              modelType: ModelType.RESPONSE_HANDLER,
              input: (v: string) => v.includes("Linear"),
              toolName: "HANDLE_RESPONSE",
            },
            response: {
              contexts: ["connectors"],
              intents: ["linear"],
              replyText: "",
              threadOps: [],
              candidateActionNames: [LINEAR],
            },
            times: 1,
          },
          {
            name: "linear-planner",
            match: {
              modelType: ModelType.ACTION_PLANNER,
              input: (v: string) => v.includes("Linear"),
              toolName: LINEAR,
            },
            response: {
              text: "",
              thought: "Search Linear issues.",
              messageToUser: "",
              completed: true,
              finishReason: "tool-calls",
              toolCalls: [
                {
                  id: "call-linear",
                  name: LINEAR,
                  type: "function",
                  arguments: { action: "search_issues" },
                },
              ],
            },
            times: 1,
          },
          {
            // searchIssues extracts filters from free text via TEXT_LARGE, then
            // parseLinearPromptResponse pulls the JSON object out.
            name: "linear-filters",
            match: {
              modelType: ModelType.TEXT_LARGE,
              input: (v: string) =>
                v.includes("Linear") || v.includes("filter"),
            },
            response: JSON.stringify({ query: "open", limit: 10 }),
            times: 1,
          },
          {
            // After the LINEAR tool returns, the runtime makes a final
            // RESPONSE_HANDLER (no tool) to decide whether to continue; the
            // empty search result is terminal, so FINISH.
            name: "linear-decision",
            match: (call: { modelType: string; toolNames: string[] }) =>
              call.modelType === ModelType.RESPONSE_HANDLER &&
              !call.toolNames.includes("HANDLE_RESPONSE"),
            response: {
              success: true,
              decision: "FINISH",
              thought: "Linear search returned no issues; nothing more to do.",
              messageToUser: "No issues found matching your search criteria.",
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
      name: "restore-linear-fetch",
      apply: () => {
        restoreFetch?.();
        return undefined;
      },
    },
  ],

  rooms: [
    { id: "main", source: "dashboard", channelType: "DM", title: "Linear" },
  ],

  turns: [
    {
      kind: "message",
      name: "search",
      text: "Search Linear for open issues.",
      timeoutMs: 120_000,
      assertTurn: (turn) => {
        const call = turn.actionsCalled.find((a) => a.actionName === LINEAR);
        if (!call) {
          return `Expected ${LINEAR} but got: ${turn.actionsCalled
            .map((a) => a.actionName)
            .join(", ")}`;
        }
        if (!call.result?.success) {
          return `${LINEAR} did not succeed: ${
            call.error?.message ?? call.result?.text ?? "unknown error"
          }`;
        }
      },
    },
  ],

  finalChecks: [
    {
      type: "actionCalled",
      actionName: LINEAR,
      status: "success",
      minCount: 1,
    },
    {
      // Effect proof (#11381): the search really queried the Linear GraphQL
      // mock for issues and surfaced its empty result set (issues: [],
      // count: 0) — not just "the handler returned success".
      type: "custom",
      name: "linear-search-effect",
      predicate: (ctx) => {
        const issuesQuery = linearMockQueries.find((query) =>
          /issues/i.test(query),
        );
        if (!issuesQuery) {
          return `Linear API mock never received an issues query; served ${linearMockQueries.length} query(ies)`;
        }
        const data = successfulActionData(ctx, LINEAR);
        if (!data) {
          return `no successful ${LINEAR} result data; calls: ${describeCalls(ctx)}`;
        }
        if (!Array.isArray(data.issues) || data.issues.length !== 0) {
          return `mock workspace has no issues, so result.data.issues must be an empty array; saw ${JSON.stringify(data.issues ?? null).slice(0, 200)}`;
        }
        if (data.count !== 0) {
          return `expected result.data.count 0 for the empty mock workspace, saw ${String(data.count ?? "(missing)")}`;
        }
      },
    },
  ],
});
