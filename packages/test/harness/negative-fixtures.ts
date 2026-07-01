/**
 * Shared negative / adversarial response fixture pack.
 *
 * The deterministic proxy can emit *deliberately wrong* model output so a plugin
 * author can prove their action degrades safely instead of silently succeeding.
 * This codifies the negative cases the issue calls for — malformed JSON, a
 * wrong tool, a hallucinated (non-existent) tool, empty output, and a truncated
 * (`finishReason: "length"`) response — as a reusable pack rather than per-test
 * reinvention.
 *
 * The correct/incorrect contract:
 *  - The *correct* path is declared with `./action-route-fixtures.ts`'s
 *    {@link strictActionRouteFixtures} (exact tool-call, validated).
 *  - The *incorrect* path is declared here. Every adversarial fixture sets
 *    `validateResponse: false` on the planner stage so the bad output reaches
 *    the runtime (the proxy does not pre-reject it); the test then asserts the
 *    runtime/plugin surfaces an error, retries, or falls back — never a silent
 *    success. The Stage-1 routing fixture stays valid, isolating the failure to
 *    the planner (the realistic "model picked the right action but botched the
 *    tool call" case).
 *
 * @example
 * ```ts
 * import { withMockLlmRuntime } from "@elizaos/test-harness";
 * import { adversarialActionRouteFixtures } from "@elizaos/test-harness/negative-fixtures";
 *
 * const harness = await withMockLlmRuntime({
 *   plugins: [myPlugin],
 *   fixtures: adversarialActionRouteFixtures("malformed-json", {
 *     input: "do the thing",
 *     intendedAction: "DO_THING",
 *   }),
 * });
 * // ...drive the turn, assert it did NOT silently succeed...
 * ```
 */

import type { JsonValue } from "@elizaos/core";
import { ModelType } from "@elizaos/core";
import type {
  LlmProxyFixture,
  LlmProxyResponse,
} from "../mocks/helpers/llm-proxy-plugin.ts";
import {
  actionSlug,
  matchesScenarioInput,
  stage1ResponseHandlerFixture,
} from "./action-route-fixtures.ts";

/** The catalogue of adversarial model-output shapes. */
export const ADVERSARIAL_KINDS = [
  "malformed-json",
  "wrong-tool",
  "hallucinated-tool",
  "empty",
  "truncated",
] as const;

export type AdversarialKind = (typeof ADVERSARIAL_KINDS)[number];

/** Human-readable description of what each adversarial kind models. */
export const ADVERSARIAL_KIND_DESCRIPTIONS: Record<AdversarialKind, string> = {
  "malformed-json": "planner output that is not parseable JSON",
  "wrong-tool":
    "a valid tool-call naming a different (real) action than intended",
  "hallucinated-tool": "a tool-call naming an action that does not exist",
  empty: "an empty model response",
  truncated: "a response cut off mid-JSON (finishReason: 'length')",
};

export interface AdversarialFixtureSpec {
  /** The user text for this turn (used for matching + Stage-1 routing). */
  input: string;
  /** The action the model *should* have called (drives valid Stage-1 routing). */
  intendedAction: string;
  /** Arguments the correct tool-call would have carried. */
  args?: Record<string, JsonValue>;
  /** For `"wrong-tool"`: a different, real action to call instead. */
  wrongToolName?: string;
  /** For `"hallucinated-tool"`: the made-up action name. */
  hallucinatedToolName?: string;
  /** Stage-1 context ids. */
  contextIds?: readonly string[];
  /** Stage-1 reply text. */
  messageToUser?: string;
}

const DEFAULT_HALLUCINATED_TOOL = "TOTALLY_MADE_UP_ACTION";

function adversarialPlannerResponse(
  kind: AdversarialKind,
  spec: AdversarialFixtureSpec,
): LlmProxyResponse {
  const slug = actionSlug(spec.intendedAction);
  const args = spec.args ?? {};
  switch (kind) {
    case "malformed-json":
      // Not valid JSON — a parser MUST reject this rather than guess.
      return `{ "toolCalls": [ { "name": "${spec.intendedAction}", ,, ]`;
    case "wrong-tool":
      return {
        finishReason: "tool-calls",
        toolCalls: [
          {
            id: `call-${slug}-wrong`,
            name: spec.wrongToolName ?? "REPLY",
            type: "function",
            arguments: args,
          },
        ],
      };
    case "hallucinated-tool":
      return {
        finishReason: "tool-calls",
        toolCalls: [
          {
            id: `call-${slug}-hallucinated`,
            name: spec.hallucinatedToolName ?? DEFAULT_HALLUCINATED_TOOL,
            type: "function",
            arguments: args,
          },
        ],
      };
    case "empty":
      return "";
    case "truncated":
      // A response that begins a tool-call payload and is cut off by a token
      // limit — partial, unparseable, with the truncation signal preserved.
      return (
        '{"finishReason":"length","toolCalls":[{"id":"call-' +
        slug +
        '","name":"' +
        spec.intendedAction +
        '","type":"function","arguments":{'
      );
  }
}

/**
 * The adversarial planner fixture for one kind. Matches the `ACTION_PLANNER`
 * call for `spec.input` and emits deliberately-wrong output with
 * `validateResponse: false` so it reaches the runtime unfiltered.
 */
export function adversarialPlannerFixture(
  kind: AdversarialKind,
  spec: AdversarialFixtureSpec,
): LlmProxyFixture {
  const slug = actionSlug(spec.intendedAction);
  return {
    name: `adversarial-${kind}-planner-${slug}-${spec.input}`,
    match: {
      modelType: ModelType.ACTION_PLANNER,
      input: matchesScenarioInput(spec.input),
    },
    response: adversarialPlannerResponse(kind, spec),
    validateResponse: false,
    times: 1,
  };
}

/**
 * The valid Stage-1 routing fixture plus the adversarial planner fixture, so a
 * strict-mode proxy has an exact fixture for both calls of the turn while the
 * planner stage misbehaves.
 */
export function adversarialActionRouteFixtures(
  kind: AdversarialKind,
  spec: AdversarialFixtureSpec,
): LlmProxyFixture[] {
  return [
    stage1ResponseHandlerFixture({
      actionName: spec.intendedAction,
      args: spec.args ?? {},
      contextIds: spec.contextIds,
      input: spec.input,
      messageToUser: spec.messageToUser,
    }),
    adversarialPlannerFixture(kind, spec),
  ];
}
