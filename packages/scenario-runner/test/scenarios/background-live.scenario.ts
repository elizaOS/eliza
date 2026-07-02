import type { ScenarioTurnExecution } from "@elizaos/scenario-runner/schema";
import { scenario } from "@elizaos/scenario-runner/schema";
import {
  jsonResponse,
  readAppControlHttpRequests,
  registerAppControlHttpHandler,
  resetAppControlHttpLoopback,
} from "./_helpers/app-control-http-loopback";

/**
 * Real-LLM (live lane) counterpart of deterministic-background-actions
 * (#10694). The keyless PR lane invokes the BACKGROUND handler directly; this
 * scenario instead sends natural chat phrasing through the full agent loop, so
 * a REAL model must route each message to the BACKGROUND action itself:
 * set-color -> undo -> redo -> reset. The real plugin-app-control handler then
 * broadcasts `background:apply` through the loopback API.
 *
 * Assertions pin the behavior contract — the action fired with the right op
 * (`values.op` + broadcast payload ledger) — never the model's reply phrasing.
 * The set-turn color is asserted as "a normalized 6-digit hex", not one exact
 * value: the handler resolves "dark blue" from the text to #1e3a8a, but a live
 * model may legitimately pass its own dark-blue hex as an explicit `color`
 * option, which `inferBackgroundPlan` gives precedence by design.
 */

function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readPath(value: unknown, pathExpression: string): unknown {
  let current = value;
  for (const segment of pathExpression.split(".").filter(Boolean)) {
    current = toRecord(current)[segment];
  }
  return current;
}

function valuesEqual(actual: unknown, expected: unknown): boolean {
  return JSON.stringify(actual) === JSON.stringify(expected);
}

const HEX_COLOR_RE = /^#[0-9a-f]{6}$/;

function expectBackgroundOp(
  execution: ScenarioTurnExecution,
  resultFields: Record<string, unknown | RegExp>,
): string | undefined {
  const action = execution.actionsCalled.find(
    (candidate) => candidate.actionName === "BACKGROUND",
  );
  if (!action) {
    return `expected the model to route to BACKGROUND, saw ${execution.actionsCalled.map((candidate) => candidate.actionName).join(", ") || "none"}`;
  }
  if (action.result?.success !== true) {
    return `expected BACKGROUND result.success=true, saw ${JSON.stringify(action.result)}`;
  }
  for (const [pathExpression, expectedValue] of Object.entries(resultFields)) {
    const actual = readPath(action.result, pathExpression);
    if (expectedValue instanceof RegExp) {
      if (typeof actual !== "string" || !expectedValue.test(actual)) {
        return `expected BACKGROUND result.${pathExpression} to match ${expectedValue}, saw ${JSON.stringify(actual)}`;
      }
      continue;
    }
    if (!valuesEqual(actual, expectedValue)) {
      return `expected BACKGROUND result.${pathExpression}=${JSON.stringify(expectedValue)}, saw ${JSON.stringify(actual)}`;
    }
  }
  return undefined;
}

function backgroundApplyPayloads(): unknown[] {
  return readAppControlHttpRequests(
    (request) =>
      request.method === "POST" &&
      request.pathname === "/api/views/events/broadcast" &&
      toRecord(request.body).type === "background:apply",
  ).map((request) => toRecord(request.body).payload ?? null);
}

export default scenario({
  id: "background-live",
  lane: "live-only",
  title: "Real LLM drives BACKGROUND set/undo/redo/reset from chat",
  domain: "scenario-runner",
  tags: ["live", "real-llm", "app-control", "background"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-app-control"],
  },
  seed: [
    {
      type: "custom",
      name: "register background broadcast loopback API",
      apply: () => {
        resetAppControlHttpLoopback();
        registerAppControlHttpHandler((request) => {
          if (
            request.method === "POST" &&
            request.pathname === "/api/views/events/broadcast"
          ) {
            return jsonResponse({ ok: true, delivered: 1 });
          }
          return undefined;
        });
        return undefined;
      },
    },
  ],
  rooms: [
    {
      id: "main",
      source: "chat",
      title: "Background Live",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "set a dark blue background from natural phrasing",
      room: "main",
      text: "Please make my background dark blue.",
      expectedActions: ["BACKGROUND"],
      assertTurn: (execution) =>
        expectBackgroundOp(execution, {
          "values.op": "set",
          "values.mode": "shader",
          "values.color": HEX_COLOR_RE,
        }),
    },
    {
      kind: "message",
      name: "undo the background change",
      room: "main",
      text: "Undo the background change.",
      expectedActions: ["BACKGROUND"],
      assertTurn: (execution) =>
        expectBackgroundOp(execution, { "values.op": "undo" }),
    },
    {
      kind: "message",
      name: "redo the background change",
      room: "main",
      text: "Actually, redo the background change.",
      expectedActions: ["BACKGROUND"],
      assertTurn: (execution) =>
        expectBackgroundOp(execution, { "values.op": "redo" }),
    },
    {
      kind: "message",
      name: "reset the background to default",
      room: "main",
      text: "Reset the background to the default.",
      expectedActions: ["BACKGROUND"],
      assertTurn: (execution) =>
        expectBackgroundOp(execution, { "values.op": "reset" }),
    },
  ],
  finalChecks: [
    {
      type: "actionCalled",
      actionName: "BACKGROUND",
      status: "success",
      minCount: 4,
    },
    {
      type: "custom",
      name: "background:apply broadcast ops are exact and ordered",
      predicate: () => {
        const payloads = backgroundApplyPayloads().map(toRecord);
        const ops = payloads.map((payload) => payload.op);
        if (JSON.stringify(ops) !== '["set","undo","redo","reset"]') {
          return `expected exactly one background:apply per turn in order set,undo,redo,reset — saw ops ${JSON.stringify(ops)} (payloads ${JSON.stringify(payloads)})`;
        }
        const set = payloads[0];
        if (
          set.mode !== "shader" ||
          typeof set.color !== "string" ||
          !HEX_COLOR_RE.test(set.color)
        ) {
          return `expected the set payload to be a shader-mode hex color, saw ${JSON.stringify(set)}`;
        }
        for (const [index, op] of [
          [1, "undo"],
          [2, "redo"],
          [3, "reset"],
        ] as const) {
          if (JSON.stringify(payloads[index]) !== JSON.stringify({ op })) {
            return `expected payload ${index} to be exactly {"op":"${op}"}, saw ${JSON.stringify(payloads[index])}`;
          }
        }
        return undefined;
      },
    },
  ],
});
