/**
 * RESTORE_CONTEXT offers only scopes that can still be read. Restoration is
 * one-shot per scope, and a request for an already-restored scope is rejected
 * as repeated restoration, which ends the turn.
 */

import type { ContextObject, PlannerRuntime } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { stageOneEvent } from "./__tests__/planner-fixtures.ts";
import { runPlannerLoop } from "./planner-loop.ts";

function restoreScopes(params: unknown): unknown {
  const tools =
    (
      params as {
        tools?: Array<{
          name?: string;
          parameters?: { properties?: { scope?: { enum?: unknown } } };
        }>;
      }
    ).tools ?? [];
  return tools.find((tool) => tool.name === "RESTORE_CONTEXT")?.parameters
    ?.properties?.scope?.enum;
}

/** Deferred FACTS plus a referenced (deferred) retrieval-query diagnostic. */
const context = {
  id: "restore-context-scope",
  metadata: { providerDiscoveryEnabled: true },
  events: [
    {
      id: "provider:FACTS",
      type: "provider",
      name: "FACTS",
      text: `FACTS\n${"remembered fact about the owner. ".repeat(40)}`,
      discoveryText: "FACTS: 40 remembered facts; restore to read them.",
    },
    stageOneEvent({
      plan: {
        actionSurface: {
          mode: "tiered",
          queryTokens: Array.from({ length: 40 }, (_, i) => `token${i}`),
        },
      },
    }),
  ],
} as unknown as ContextObject;

describe("RESTORE_CONTEXT scope exposure", () => {
  it("stops offering a scope once it has been restored", async () => {
    const offered: unknown[] = [];
    const runtime: PlannerRuntime = {
      useModel: async (_type, params) => {
        offered.push(restoreScopes(params));
        if (offered.length > 2) throw new Error("Unexpected extra model call");
        return offered.length === 1
          ? {
              text: "",
              toolCalls: [
                {
                  id: "restore-providers",
                  name: "RESTORE_CONTEXT",
                  arguments: {
                    scope: "providers",
                    reason: "Need the complete FACTS references.",
                  },
                },
              ],
            }
          : {
              text: "",
              toolCalls: [
                {
                  id: "reply",
                  name: "REPLY",
                  arguments: { text: "checked." },
                },
              ],
            };
      },
    };
    await runPlannerLoop({
      runtime,
      context,
      tools: [
        {
          name: "WEB_FETCH",
          description: "Fetch one URL.",
          parameters: {
            type: "object",
            properties: { url: { type: "string" } },
          },
        },
      ],
      executeToolCall: async () => {
        throw new Error("Unexpected effect");
      },
      evaluate: async () => ({
        success: true,
        decision: "FINISH",
        messageToUser: "checked.",
      }),
    });
    expect(offered).toEqual([
      ["history", "providers", "full"],
      ["history", "full"],
    ]);
  });
});
