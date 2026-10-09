/**
 * Real Core/Edge execution with deterministic HTTP boundaries; no provider traffic.
 * Budget: one existing preflight, zero extra searches, zero initial free-query
 * selection for a qualified single read. Post-tool model work remains canonical.
 */
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { AgentRuntime, ChannelType } from "@elizaos/core/edge";
import type { RunSharedAgentTurnResult } from "./run-shared-agent-turn";
import { SharedRuntimeTurnError } from "./shared-runtime-errors";

const SOURCE_URL = "https://weather.example/current";
const CLAIM = "Springfield, Missouri is 75 Fahrenheit and sunny.";
const MARKED = `${CLAIM} [[SOURCE_URL:${SOURCE_URL}]]`;
const QUERY = "current public weather in Springfield, Missouri";
const PROMPT = "What is the current weather in Springfield, Missouri?";
const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_KEY = process.env.CEREBRAS_API_KEY;
const ORIGINAL_FALLBACK_KEY = process.env.OPENROUTER_API_KEY;
const ORIGINAL_NODE_ENV = process.env.NODE_ENV;

beforeEach(() => {
  process.env.CEREBRAS_API_KEY = "offline-preflight-test-key";
  delete process.env.OPENROUTER_API_KEY;
  process.env.NODE_ENV = "production";
});
afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  if (ORIGINAL_KEY === undefined) delete process.env.CEREBRAS_API_KEY;
  else process.env.CEREBRAS_API_KEY = ORIGINAL_KEY;
  if (ORIGINAL_FALLBACK_KEY === undefined) delete process.env.OPENROUTER_API_KEY;
  else process.env.OPENROUTER_API_KEY = ORIGINAL_FALLBACK_KEY;
  if (ORIGINAL_NODE_ENV === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = ORIGINAL_NODE_ENV;
});

type Mode = { compound?: boolean; deny?: boolean; ordinary?: boolean; unavailable?: boolean };
function modelResponse(content: string | null, calls: Array<{ name: string; args: object }> = []) {
  return Response.json({
    id: "offline-preflight",
    object: "chat.completion",
    created: 0,
    model: "qwen-3.8-27b",
    choices: [{
      index: 0,
      message: {
        role: "assistant",
        content,
        ...(calls.length ? { tool_calls: calls.map((call, index) => ({
          id: `offline-tool-${index}`,
          type: "function",
          function: { name: call.name, arguments: JSON.stringify(call.args) },
        })) } : {}),
      },
      finish_reason: calls.length ? "tool_calls" : "stop",
    }],
    usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 },
  });
}

async function exercise(mode: Mode = {}, reply = MARKED) {
  let searches = 0;
  let modelCalls = 0;
  let freeSelectionsBeforeAction = 0;
  let validations = 0;
  let otherActions = 0;
  let canonicalReceiptSeen = false;
  let registeredShortcut = false;
  const actions: Array<{ query: unknown; success: boolean }> = [];
  const restorers: Array<{ mockRestore(): void }> = [];
  const initialize = AgentRuntime.prototype.initialize;
  const initialization = spyOn(AgentRuntime.prototype, "initialize").mockImplementation(
    async function (this: AgentRuntime, options) {
      const result = await initialize.call(this, options);
      registeredShortcut ||= this.responseHandlerEvaluators.some(
        (evaluator) => evaluator.name === "shared.verified_public_preflight",
      );
      const action = this.actions.find((candidate) => candidate.name === "WEB_SEARCH");
      if (action) {
        const handler = action.handler;
        const validate = action.validate;
        restorers.push(spyOn(action, "validate").mockImplementation(async (...args) => {
          validations += 1;
          return mode.deny ? false : await validate(...args);
        }));
        restorers.push(spyOn(action, "handler").mockImplementation(async (...args) => {
          const options = args[3] as { parameters?: { query?: unknown }; query?: unknown } | undefined;
          const query = options?.parameters?.query ?? options?.query;
          const result = await handler(...args);
          actions.push({
            query,
            success: Boolean(result && typeof result === "object" && "success" in result && result.success),
          });
          return result;
        }));
      }
      if (mode.compound) {
        this.registerAction({
          name: "OTHER_ACTION",
          description: "Perform the other requested operation.",
          tags: ["capability:write"],
          contexts: ["general"],
          roleGate: { minRole: "USER" },
          parameters: [],
          validate: async () => true,
          handler: async () => {
            otherActions += 1;
            return { success: true, text: "Other operation completed.", data: { actionName: "OTHER_ACTION", done: true } };
          },
        });
      }
      return result;
    },
  );
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const target = url instanceof Request ? url.url : String(url);
    const body = init?.body === undefined && url instanceof Request
      ? await url.clone().text()
      : String(init?.body ?? "");
    if (target === "https://search.parallel.ai/mcp") {
      searches += 1;
      if (searches > 1) throw new Error("Additional external search exceeded the offline budget");
      return Response.json({
        jsonrpc: "2.0",
        id: "offline-preflight",
        result: { content: [{
          type: "text",
          text: JSON.stringify({ results: mode.unavailable ? [] : [{
            url: SOURCE_URL, title: "Springfield, Missouri weather", text: CLAIM,
          }] }),
        }] },
      });
    }
    if (target !== "https://api.cerebras.ai/v1/chat/completions") {
      throw new Error("Unexpected network boundary in offline Core test");
    }
    const request = JSON.parse(body) as {
      tools?: Array<{ function?: { name?: string } }>;
      messages?: Array<Record<string, unknown>>;
    };
    modelCalls += 1;
    const names = request.tools?.map((tool) => tool.function?.name) ?? [];
    if (names.includes("HANDLE_RESPONSE")) {
      return modelResponse(null, [{
        name: "HANDLE_RESPONSE",
        args: {
          shouldRespond: "RESPOND",
          thought: "Use the current authorized operation.",
          contexts: mode.ordinary ? ["simple"] : ["general"],
          intents: mode.compound ? ["current weather", "other operation"] : [],
          candidateActionNames: mode.ordinary ? [] : mode.compound ? ["WEB_SEARCH", "OTHER_ACTION"] : ["WEB_SEARCH"],
          requiresTool: !mode.ordinary,
          replyText: mode.ordinary ? "Hello! Happy to help." : "",
          replyEffectStatus: "none",
          facts: [], relationships: [], addressedTo: [],
        },
      }]);
    }
    const context = JSON.stringify(request.messages);
    canonicalReceiptSeen ||= context.includes("response-handler:WEB_SEARCH") && context.includes(QUERY);
    if (names.includes("WEB_SEARCH") && actions.length === 0 && !mode.deny) {
      freeSelectionsBeforeAction += 1;
      return modelResponse(null, [
        { name: "WEB_SEARCH", args: { query: QUERY, eliza_turn_scope: "final" } },
        ...(mode.compound ? [{ name: "OTHER_ACTION", args: { eliza_turn_scope: "final" } }] : []),
      ]);
    }
    if (context.includes("evaluator_stage:") || names.length > 0) {
      return modelResponse(JSON.stringify({
        success: !mode.deny,
        decision: "FINISH",
        thought: "Use the settled operation result.",
        messageToUser: mode.deny ? "The requested operation was denied." : reply,
      }));
    }
    return modelResponse(mode.deny ? "The requested operation was denied." : reply);
  }) as typeof fetch;
  let result: RunSharedAgentTurnResult | undefined;
  let failed = false;
  let failureCategory: "canonical_action_denied" | "canonical_search_unavailable" | undefined;
  try {
    const { runSharedAgentTurn } = await import("./run-shared-agent-turn");
    result = await runSharedAgentTurn({
      character: { name: "Shared Eliza", system: "You are Eliza.", model: "qwen-3.8-27b" },
      history: [],
      message: mode.ordinary ? "Hello there" : mode.compound ? `${PROMPT} Also perform the other operation.` : PROMPT,
      ...(mode.ordinary ? {} : { capabilityText: mode.compound ? `${PROMPT} Also perform the other operation.` : PROMPT }),
      messageIds: {
        user: "35fa7289-3e70-4c0b-a64a-52fb8cc9a10d",
        assistant: "3639b50e-f237-4b9a-99fa-75d890c1f97d",
      },
      execution: {
        channel: { type: ChannelType.DM, source: "shared-runtime" },
        authenticatedPersonalSharedUser: true,
        agentKey: "personal:b55d99d0-ae38-4c7c-8791-7443e5de8ebc",
        roomKey: "offline-preflight-room",
      },
    });
  } catch (error) {
    if (!(error instanceof SharedRuntimeTurnError)) throw error;
    const kinds: unknown[] = [];
    let current: unknown = error;
    for (let depth = 0; depth < 8 && current && typeof current === "object"; depth += 1) {
      const record = current as { kind?: unknown; context?: { failureKind?: unknown }; cause?: unknown };
      kinds.push(record.kind, record.context?.failureKind);
      current = record.cause;
    }
    if (mode.deny && validations > 0 && actions.length === 0 && kinds.includes("missing_capability")) {
      failureCategory = "canonical_action_denied";
    } else if (
      mode.unavailable &&
      actions.length > 0 &&
      actions.every((action) => !action.success) &&
      kinds.some((kind) => kind === "handler_error" || kind === "missing_capability" || kind === "planner_exhaustion")
    ) {
      failureCategory = "canonical_search_unavailable";
    } else {
      throw error;
    }
    failed = true;
  } finally {
    initialization.mockRestore();
    for (const spy of restorers) spy.mockRestore();
  }
  return { result, failed, failureCategory, searches, modelCalls, freeSelectionsBeforeAction, validations, otherActions, actions, canonicalReceiptSeen, registeredShortcut };
}

test("genuine preflight enters canonical execution without free-query selection", async () => {
  const actual = await exercise();
  expect(actual.registeredShortcut).toBe(true);
  expect(actual.searches).toBe(1);
  expect(actual.freeSelectionsBeforeAction).toBe(0);
  expect(actual.actions).toEqual([{ query: QUERY, success: true }]);
  expect(actual.canonicalReceiptSeen).toBe(true);
  expect(actual.result?.reply).toStartWith(CLAIM);
  expect(actual.result?.actionResults?.filter((result) => result.data?.actionName === "WEB_SEARCH")).toHaveLength(1);
});

test("canonical denial and unsupported source claims retain their gates", async () => {
  const unsupported = await exercise({}, `Springfield, Missouri is 75 EUR. [[SOURCE_URL:${SOURCE_URL}]]`);
  expect(unsupported.actions).toEqual([{ query: QUERY, success: true }]);
  expect(unsupported.result?.reply).toContain("couldn’t safely bind");
  const denied = await exercise({ deny: true });
  expect(denied.validations).toBeGreaterThan(0);
  expect(denied.actions).toHaveLength(0);
  expect(denied.searches).toBe(1);
  if (denied.failed) {
    expect(denied.failureCategory).toBe("canonical_action_denied");
  } else {
    expect(denied.result?.reply).toMatch(/couldn’t safely bind|can’t verify|denied/i);
  }
});

test("compound work remains planner-owned and retains the other action", async () => {
  const actual = await exercise({ compound: true });
  expect(actual.freeSelectionsBeforeAction).toBeGreaterThan(0);
  expect(actual.actions).toHaveLength(1);
  expect(actual.otherActions).toBe(1);
  expect(actual.searches).toBe(1);
  expect(actual.result?.actionResults?.some((result) => result.data?.actionName === "OTHER_ACTION")).toBe(true);
});

test("ordinary chat and unavailable preflight keep their existing paths", async () => {
  const ordinary = await exercise({ ordinary: true });
  expect(ordinary.registeredShortcut).toBe(false);
  expect(ordinary.searches).toBe(0);
  expect(ordinary.modelCalls).toBe(1);
  expect(ordinary.result?.reply).toBe("Hello! Happy to help.");
  const unavailable = await exercise({ unavailable: true });
  expect(unavailable.registeredShortcut).toBe(false);
  expect(unavailable.searches).toBe(1);
  expect(unavailable.actions).toEqual([{ query: QUERY, success: false }]);
  if (unavailable.failed) {
    expect(unavailable.failureCategory).toBe("canonical_search_unavailable");
  } else {
    expect(unavailable.result?.reply).toContain("can’t verify the current value");
  }
});
