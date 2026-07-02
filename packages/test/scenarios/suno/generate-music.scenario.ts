/**
 * Keyless per-plugin e2e for `@elizaos/plugin-suno` (issue #8801).
 *
 * The Suno plugin contributes no top-level action of its own — it exports
 * `sunoGenerateMusicHandler`, which the MUSIC umbrella action
 * (`@elizaos/plugin-music`) dispatches for the `generate` / `custom_generate` /
 * `extend` subactions. This scenario exercises that real path end-to-end: the
 * planner selects `MUSIC` with `action: "generate"`, the MUSIC handler routes
 * to `sunoGenerateMusicHandler`, which POSTs to the Suno REST API. A scoped
 * fetch interceptor mocks `api.suno.ai` so there is no live credential or
 * network — deterministic under the strict LLM proxy.
 */
import type { AgentRuntime } from "@elizaos/core";
import { ModelType } from "@elizaos/core";
import { scenario } from "@elizaos/scenario-runner/schema";
import {
  describeCalls,
  successfulActionData,
  toRecord,
} from "../_helpers/effect-assertions.ts";

const MUSIC = "MUSIC";

/** POST bodies the Suno API mock actually served. */
let sunoMockRequests: string[] = [];
type R = AgentRuntime & {
  setSetting?: (k: string, v: string) => void;
  scenarioLlmFixtures?: {
    register: (...f: Array<Record<string, unknown>>) => void;
  };
};

let restoreFetch: (() => void) | undefined;

export default scenario({
  lane: "pr-deterministic",
  id: "suno.generate-music",
  title: "Suno: generate music via the MUSIC action against a mocked Suno API",
  domain: "suno",
  tags: ["smoke", "suno", "music"],
  description:
    "Generates music through the MUSIC action's Suno-backed `generate` subaction against a scoped mock of the Suno REST API — keyless, no live credentials.",

  requires: { plugins: ["@elizaos/plugin-music", "@elizaos/plugin-suno"] },
  isolation: "per-scenario",

  seed: [
    {
      type: "custom",
      name: "suno-mock-and-config",
      apply: async (ctx) => {
        const runtime = ctx.runtime as R;
        sunoMockRequests = [];

        // Scoped fetch interceptor: redirect SunoProvider's REST calls to a mock.
        const realFetch = globalThis.fetch;
        restoreFetch = () => {
          if (globalThis.fetch === sunoMockFetch) {
            globalThis.fetch = realFetch;
          }
          restoreFetch = undefined;
        };
        const sunoMockFetch = (async (
          input: RequestInfo | URL,
          init?: RequestInit,
        ) => {
          const url =
            typeof input === "string"
              ? input
              : input instanceof Request
                ? input.url
                : input.toString();
          if (url.includes("api.suno.ai")) {
            sunoMockRequests.push(String(init?.body ?? ""));
            return new Response(
              JSON.stringify({
                id: "suno-gen-1",
                status: "pending",
                audio_url: null,
              }),
              { headers: { "Content-Type": "application/json" } },
            );
          }
          return realFetch(input, init);
        }) as typeof fetch;
        globalThis.fetch = sunoMockFetch;

        process.env.SUNO_API_KEY = "suno_test_dummy";
        runtime.setSetting?.("SUNO_API_KEY", "suno_test_dummy");

        runtime.scenarioLlmFixtures?.register(
          {
            name: "suno-stage1",
            match: {
              modelType: ModelType.RESPONSE_HANDLER,
              input: (v: string) => v.includes("lofi"),
              toolName: "HANDLE_RESPONSE",
            },
            response: {
              contexts: ["media"],
              intents: ["music"],
              replyText: "",
              threadOps: [],
              candidateActionNames: [MUSIC],
            },
            times: 1,
          },
          {
            name: "suno-planner",
            match: {
              modelType: ModelType.ACTION_PLANNER,
              input: (v: string) => v.includes("lofi"),
              toolName: MUSIC,
            },
            response: {
              text: "",
              thought: "Generate a new track with Suno.",
              messageToUser: "",
              completed: true,
              finishReason: "tool-calls",
              toolCalls: [
                {
                  id: "call-suno",
                  name: MUSIC,
                  type: "function",
                  arguments: {
                    action: "generate",
                    prompt: "an upbeat lofi study beat",
                  },
                },
              ],
            },
            times: 1,
          },
          {
            name: "suno-decision",
            match: (call: { modelType: string; toolNames: string[] }) =>
              call.modelType === ModelType.RESPONSE_HANDLER &&
              !call.toolNames.includes("HANDLE_RESPONSE"),
            response: {
              success: true,
              decision: "FINISH",
              thought: "Generation submitted; nothing more to do.",
              messageToUser: "Your track is being generated.",
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
      name: "restore-suno-fetch",
      apply: () => {
        restoreFetch?.();
        return undefined;
      },
    },
  ],

  rooms: [
    { id: "main", source: "dashboard", channelType: "DM", title: "Suno" },
  ],

  turns: [
    {
      kind: "message",
      name: "generate",
      text: "Generate an upbeat lofi study beat music track.",
      timeoutMs: 120_000,
      assertTurn: (turn) => {
        const call = turn.actionsCalled.find((a) => a.actionName === MUSIC);
        if (!call) {
          return `Expected ${MUSIC} but got: ${turn.actionsCalled
            .map((a) => a.actionName)
            .join(", ")}`;
        }
        if (!call.result?.success) {
          return `${MUSIC} did not succeed: ${
            call.error?.message ?? call.result?.text ?? "unknown error"
          }`;
        }
      },
    },
  ],

  finalChecks: [
    {
      type: "actionCalled",
      actionName: MUSIC,
      status: "success",
      minCount: 1,
    },
    {
      // Effect proof (#11381): the generate subaction really submitted the
      // prompt to the Suno REST mock and surfaced the mock's pending
      // generation (id suno-gen-1) in the action result — not just
      // "the handler returned success".
      type: "custom",
      name: "suno-generation-submitted-effect",
      predicate: (ctx) => {
        const submitted = sunoMockRequests.find((body) =>
          body.includes("lofi"),
        );
        if (!submitted) {
          return `Suno API mock never received the generation prompt; served ${sunoMockRequests.length} request(s): ${sunoMockRequests
            .map((body) => body.slice(0, 120))
            .join(" | ")}`;
        }
        const data = successfulActionData(ctx, MUSIC);
        if (!data) {
          return `no successful ${MUSIC} result data; calls: ${describeCalls(ctx)}`;
        }
        if (data.subaction !== "generate") {
          return `expected result.data.subaction "generate", saw ${String(data.subaction ?? "(missing)")}`;
        }
        const response = toRecord(data.response);
        if (response?.id !== "suno-gen-1" || response.status !== "pending") {
          return `expected the mock's submitted generation (id suno-gen-1, status pending) in result.data.response; saw ${JSON.stringify(data.response ?? null).slice(0, 200)}`;
        }
      },
    },
  ],
});
