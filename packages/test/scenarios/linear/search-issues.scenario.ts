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

const LINEAR = "LINEAR";
type R = AgentRuntime & {
  setSetting?: (k: string, v: string) => void;
  scenarioLlmFixtures?: {
    register: (...f: Array<Record<string, unknown>>) => void;
  };
};

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
        // Scoped fetch interceptor: redirect @linear/sdk's calls to a mock.
        const realFetch = globalThis.fetch;
        globalThis.fetch = (async (
          input: RequestInfo | URL,
          init?: RequestInit,
        ) => {
          const url = typeof input === "string" ? input : input.toString();
          if (url.includes("api.linear.app")) {
            let query = "";
            try {
              query = JSON.parse(String(init?.body ?? "{}")).query ?? "";
            } catch {}
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
  ],
});
