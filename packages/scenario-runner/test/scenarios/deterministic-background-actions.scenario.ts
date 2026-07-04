/**
 * Keyless catalog coverage for the plugin-app-control BACKGROUND action and the
 * `background:apply` payload contract. Runs on the pr-deterministic lane under
 * the LLM proxy; background-live proves a real model drives the same path.
 */
import type { ScenarioTurnExecution } from "@elizaos/scenario-runner/schema";
import { scenario } from "@elizaos/scenario-runner/schema";
import {
  jsonResponse,
  readAppControlHttpRequests,
  registerAppControlHttpHandler,
  resetAppControlHttpLoopback,
} from "./_helpers/app-control-http-loopback";

/**
 * Deterministic BACKGROUND action catalog (#10694).
 *
 * Exercises the real plugin-app-control BACKGROUND handler end to end against
 * the loopback broadcast API: named-color set, hex set, programmable GLSL
 * shader preset (text + explicit `preset` param), a relative uniform tweak,
 * undo, redo, and reset. Every turn asserts the exact reply and result fields,
 * and the final custom check pins the exact ordered `background:apply`
 * broadcast ledger the renderer would consume — proving the emitted payload
 * contract, not just that the handler returned success.
 */

function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function actionParameters(value: unknown): Record<string, unknown> {
  const params = toRecord(value);
  return toRecord(params.parameters ?? params);
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

function expectBackgroundTurn(
  execution: ScenarioTurnExecution,
  expected: {
    parameters?: Record<string, unknown>;
    responseText: string;
    resultFields: Record<string, unknown>;
  },
): string | undefined {
  if (execution.responseText !== expected.responseText) {
    return `expected responseText=${JSON.stringify(expected.responseText)}, saw ${JSON.stringify(execution.responseText)}`;
  }

  const action = execution.actionsCalled.find(
    (candidate) => candidate.actionName === "BACKGROUND",
  );
  if (!action) {
    return `expected BACKGROUND action, saw ${execution.actionsCalled.map((candidate) => candidate.actionName).join(", ") || "none"}`;
  }

  const params = actionParameters(action.parameters);
  for (const [key, expectedValue] of Object.entries(
    expected.parameters ?? {},
  )) {
    if (!valuesEqual(params[key], expectedValue)) {
      return `expected BACKGROUND parameter ${key}=${JSON.stringify(expectedValue)}, saw ${JSON.stringify(params[key])}`;
    }
  }

  if (action.result?.success !== true) {
    return `expected BACKGROUND result.success=true, saw ${JSON.stringify(action.result)}`;
  }

  for (const [pathExpression, expectedValue] of Object.entries(
    expected.resultFields,
  )) {
    const actual = readPath(action.result, pathExpression);
    if (!valuesEqual(actual, expectedValue)) {
      return `expected BACKGROUND result.${pathExpression}=${JSON.stringify(expectedValue)}, saw ${JSON.stringify(actual)}`;
    }
  }

  return undefined;
}

function normalizedBroadcasts() {
  return readAppControlHttpRequests(
    (request) =>
      request.method === "POST" &&
      request.pathname === "/api/views/events/broadcast",
  ).map((request) => ({
    body: request.body ?? null,
    response: request.response
      ? { body: request.response.body ?? null, status: request.response.status }
      : null,
  }));
}

export default scenario({
  id: "deterministic-background-actions",
  lane: "pr-deterministic",
  title: "Deterministic BACKGROUND action catalog",
  domain: "scenario-runner",
  tags: ["pr", "deterministic", "zero-cost", "app-control", "background"],
  isolation: "shared-runtime",
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
      title: "Deterministic Background Catalog",
    },
  ],
  turns: [
    {
      kind: "action",
      name: "set named color background",
      text: "make the background teal",
      actionName: "BACKGROUND",
      responseIncludesAny: ["Set the background to teal."],
      assertTurn: (execution) =>
        expectBackgroundTurn(execution, {
          responseText: "Set the background to teal.",
          resultFields: {
            "values.op": "set",
            "values.mode": "shader",
            "values.color": "#0891b2",
          },
        }),
    },
    {
      kind: "action",
      name: "set hex color background",
      text: "set the background to #ff5a1f",
      actionName: "BACKGROUND",
      responseIncludesAny: ["Set the background to #ff5a1f."],
      assertTurn: (execution) =>
        expectBackgroundTurn(execution, {
          responseText: "Set the background to #ff5a1f.",
          resultFields: {
            "values.op": "set",
            "values.mode": "shader",
            "values.color": "#ff5a1f",
          },
        }),
    },
    {
      kind: "action",
      name: "set lava shader from natural phrasing",
      text: "give me a slow lava-lamp style animated background",
      actionName: "BACKGROUND",
      responseIncludesAny: ["Set the background to the lava shader."],
      assertTurn: (execution) =>
        expectBackgroundTurn(execution, {
          responseText: "Set the background to the lava shader.",
          resultFields: {
            "values.op": "set",
            "values.mode": "glsl",
            "values.presetId": "lava",
          },
        }),
    },
    {
      kind: "action",
      name: "set nebula shader via explicit preset param",
      text: "switch the background to the nebula preset",
      actionName: "BACKGROUND",
      options: { preset: "nebula" },
      responseIncludesAny: ["Set the background to the nebula shader."],
      assertTurn: (execution) =>
        expectBackgroundTurn(execution, {
          parameters: { preset: "nebula" },
          responseText: "Set the background to the nebula shader.",
          resultFields: {
            "values.op": "set",
            "values.mode": "glsl",
            "values.presetId": "nebula",
          },
        }),
    },
    {
      kind: "action",
      name: "tweak live shader slower",
      text: "make the shader slower",
      actionName: "BACKGROUND",
      responseIncludesAny: ["Made the shader background slower."],
      assertTurn: (execution) =>
        expectBackgroundTurn(execution, {
          responseText: "Made the shader background slower.",
          resultFields: {
            "values.op": "set",
            "values.mode": "glsl",
            "values.tweak": "slower",
          },
        }),
    },
    {
      kind: "action",
      name: "undo background change",
      text: "undo the background change",
      actionName: "BACKGROUND",
      responseIncludesAny: ["Reverted the background to the previous one."],
      assertTurn: (execution) =>
        expectBackgroundTurn(execution, {
          responseText: "Reverted the background to the previous one.",
          resultFields: {
            "values.op": "undo",
          },
        }),
    },
    {
      kind: "action",
      name: "redo background change",
      text: "redo the background change",
      actionName: "BACKGROUND",
      responseIncludesAny: ["Re-applied the background you undid."],
      assertTurn: (execution) =>
        expectBackgroundTurn(execution, {
          responseText: "Re-applied the background you undid.",
          resultFields: {
            "values.op": "redo",
          },
        }),
    },
    {
      kind: "action",
      name: "reset background to default",
      text: "reset the background to the default",
      actionName: "BACKGROUND",
      responseIncludesAny: ["Reset the background to the default."],
      assertTurn: (execution) =>
        expectBackgroundTurn(execution, {
          responseText: "Reset the background to the default.",
          resultFields: {
            "values.op": "reset",
          },
        }),
    },
  ],
  finalChecks: [
    {
      type: "actionCalled",
      actionName: "BACKGROUND",
      status: "success",
      minCount: 8,
    },
    {
      type: "selectedActionArguments",
      actionName: "BACKGROUND",
      includesAll: [
        /#0891b2|teal/,
        /#ff5a1f/,
        /lava shader/,
        /nebula shader/,
        /slower/,
        /Reverted the background/,
        /Re-applied the background/,
        /Reset the background to the default/,
      ],
    },
    {
      type: "custom",
      name: "background:apply broadcast ledger is exact and ordered",
      predicate: () => {
        const okResponse = {
          body: { ok: true, delivered: 1 },
          status: 200,
        };
        const expected = [
          {
            body: {
              type: "background:apply",
              payload: { op: "set", mode: "shader", color: "#0891b2" },
            },
            response: okResponse,
          },
          {
            body: {
              type: "background:apply",
              payload: { op: "set", mode: "shader", color: "#ff5a1f" },
            },
            response: okResponse,
          },
          {
            body: {
              type: "background:apply",
              payload: { op: "set", mode: "glsl", presetId: "lava" },
            },
            response: okResponse,
          },
          {
            body: {
              type: "background:apply",
              payload: { op: "set", mode: "glsl", presetId: "nebula" },
            },
            response: okResponse,
          },
          {
            body: {
              type: "background:apply",
              payload: { op: "set", mode: "glsl", uniforms: { u_speed: 0.4 } },
            },
            response: okResponse,
          },
          {
            body: { type: "background:apply", payload: { op: "undo" } },
            response: okResponse,
          },
          {
            body: { type: "background:apply", payload: { op: "redo" } },
            response: okResponse,
          },
          {
            body: { type: "background:apply", payload: { op: "reset" } },
            response: okResponse,
          },
        ];
        const actual = normalizedBroadcasts();
        return JSON.stringify(actual) === JSON.stringify(expected)
          ? undefined
          : `expected exact background:apply broadcast ledger ${JSON.stringify(expected)}, saw ${JSON.stringify(actual)}`;
      },
    },
  ],
});
