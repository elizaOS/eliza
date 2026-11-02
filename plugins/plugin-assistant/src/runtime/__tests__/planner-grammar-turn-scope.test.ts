/**
 * The local planner grammar must admit the arguments the same request's tool
 * schemas ask for: the reserved `eliza_turn_scope` that withTurnScopeToolArg
 * makes required on every tool, and the RESTORE_CONTEXT `scope` the restore
 * tool and its prompt offer.
 */

import type { ToolDefinition } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { runPlannerLoop } from "../planner-loop.ts";

type FirstRequest = {
  grammar: string;
  tools: ToolDefinition[];
  actionSchemas: Record<string, { required?: string[] }>;
};

async function firstPlannerRequest(
  input: Pick<Parameters<typeof runPlannerLoop>[0], "context" | "tools">,
): Promise<FirstRequest> {
  let request: FirstRequest | undefined;
  await runPlannerLoop({
    ...input,
    runtime: {
      useModel: async (_type, params) => {
        // The local-engine fields ride on the same request as `tools`.
        const sent = params as typeof params & { grammar?: string };
        request = {
          grammar: String(sent.grammar),
          tools: sent.tools ?? [],
          actionSchemas: (
            sent.providerOptions as {
              eliza: { plannerActionSchemas: FirstRequest["actionSchemas"] };
            }
          ).eliza.plannerActionSchemas,
        };
        throw new Error("first planner request captured");
      },
    },
    executeToolCall: async () => ({ success: true }),
    evaluate: async () => {
      throw new Error("no evaluation before the first planner request");
    },
  }).catch(() => undefined);
  if (!request) throw new Error("planner made no model request");
  return request;
}

/** Whole-string RegExp for a GBNF grammar whose root is regular. */
function grammarRegExp(grammar: string): RegExp {
  const rules = new Map<string, string>();
  for (const line of grammar.split("\n")) {
    const at = line.indexOf(" ::= ");
    if (at > 0) rules.set(line.slice(0, at), line.slice(at + 5));
  }
  const source = (expr: string): string => {
    let out = "";
    for (const [, literal, charClass, operator, name] of expr.matchAll(
      /"((?:\\.|[^"\\])*)"|(\[(?:\\.|[^\]\\])*\])|([()|*?+])|([A-Za-z][\w-]*)/g,
    )) {
      if (literal !== undefined) {
        const text = JSON.parse(`"${literal}"`) as string;
        out += text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      } else if (charClass !== undefined) out += charClass;
      else if (operator !== undefined) out += operator;
      else out += `(?:${source(rules.get(name) ?? "(?!)")})`;
    }
    return out;
  };
  return new RegExp(`^${source(rules.get("root") ?? "")}$`);
}

/** True when the grammar admits the call with its parameters in some key order. */
function admits(
  grammar: string,
  action: string,
  params: Record<string, string>,
): boolean {
  const orders = (keys: string[]): string[][] =>
    keys.length <= 1
      ? [keys]
      : keys.flatMap((key, i) =>
          orders([...keys.slice(0, i), ...keys.slice(i + 1)]).map((rest) => [
            key,
            ...rest,
          ]),
        );
  const pattern = grammarRegExp(grammar);
  return orders(Object.keys(params)).some((order) =>
    pattern.test(
      JSON.stringify({
        action,
        parameters: Object.fromEntries(order.map((key) => [key, params[key]])),
        thought: "t",
      }),
    ),
  );
}

const healthAction = {
  name: "OWNER_HEALTH",
  description: "Owner health telemetry reads.",
  parameters: [
    {
      name: "metric",
      description: "Metric for by_metric queries.",
      schema: { type: "string" as const, enum: ["steps", "sleep_hours"] },
    },
  ],
  validate: async () => true,
  handler: async () => ({ success: true }),
};

describe("local planner grammar and the sent tool schemas", () => {
  it("lets every call declare the turn scope its tool schema requires", async () => {
    const request = await firstPlannerRequest({
      context: {
        id: "turn-scope-grammar",
        events: [
          {
            id: "tool-owner-health",
            type: "tool",
            tool: {
              name: healthAction.name,
              description: healthAction.description,
              action: healthAction,
            },
          },
        ],
      },
      tools: [
        {
          name: healthAction.name,
          description: healthAction.description,
          parameters: {
            type: "object",
            properties: {
              metric: { type: "string", enum: ["steps", "sleep_hours"] },
            },
            required: [],
            additionalProperties: false,
          },
        },
      ],
    });
    const tool = request.tools.find((t) => t.name === healthAction.name);
    expect(tool?.parameters?.required).toContain("eliza_turn_scope");
    expect(request.actionSchemas[healthAction.name]?.required).toContain(
      "eliza_turn_scope",
    );
    for (const scope of ["final", "more_work_pending"]) {
      expect(
        admits(request.grammar, healthAction.name, {
          metric: "steps",
          eliza_turn_scope: scope,
        }),
      ).toBe(true);
    }
    expect(
      admits(request.grammar, healthAction.name, {
        metric: "steps",
        eliza_turn_scope: "done",
      }),
    ).toBe(false);
    expect(
      admits(request.grammar, healthAction.name, { metric: "steps" }),
    ).toBe(false);
  });

  it("lets RESTORE_CONTEXT name a scope the restore tool offers", async () => {
    const request = await firstPlannerRequest({
      context: {
        id: "provider-only",
        metadata: { providerDiscoveryEnabled: true },
        events: [
          {
            id: "facts",
            type: "provider",
            name: "FACTS",
            text: "Complete provider facts retained in the original context.",
            discoveryText: "Facts available",
          },
        ],
      },
      tools: [{ name: "READ", description: "Read a record" }],
    });
    const restore = request.tools.find((t) => t.name === "RESTORE_CONTEXT");
    expect(restore?.parameters?.properties?.scope).toMatchObject({
      enum: ["providers", "full"],
    });
    for (const scope of ["providers", "full"]) {
      expect(
        admits(request.grammar, "RESTORE_CONTEXT", {
          reason: "Read the deferred facts",
          scope,
          eliza_turn_scope: "final",
        }),
      ).toBe(true);
    }
    expect(
      admits(request.grammar, "RESTORE_CONTEXT", {
        reason: "Read the deferred facts",
        eliza_turn_scope: "final",
      }),
    ).toBe(true);
    // No history was deferred this turn, so the tool does not offer it.
    expect(
      admits(request.grammar, "RESTORE_CONTEXT", {
        reason: "Read the deferred facts",
        scope: "history",
        eliza_turn_scope: "final",
      }),
    ).toBe(false);
  });
});
