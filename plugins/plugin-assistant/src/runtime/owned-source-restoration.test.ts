import {
  type ContextObject,
  type ContextProviderEvent,
  MODEL_CANONICAL_CONTEXT,
  OWNED_CONTEXT_SOURCE_SCOPE,
  type PlannerToolCall,
} from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { runPlannerLoop } from "./planner-loop.ts";

describe("owned request source dependencies", () => {
  it.each([
    "SOURCE_OWNER",
    "VIEW_OPERATION",
    "NATIVE_CONSENT_OPERATION",
    "MIXED_OPERATIONS",
    "VIEW_CHANGES_DURING_MODEL",
  ])(
    "restores before %s only when the operation depends on deferred evidence",
    async (operation) => {
      const originalText =
        "# Active View\nLiteral controls:  Ω  and exact values.\n".repeat(20);
      let bindingCurrent = true;
      const source: ContextProviderEvent = {
        id: "original-view",
        type: "provider",
        source: "host:active-view",
        name: "ACTIVE_VIEW_SNAPSHOT",
        text: originalText,
        discoveryText: "View identity. Restore controls before dependent work.",
        discoveryRequiresRuntimeBinding: true,
        [OWNED_CONTEXT_SOURCE_SCOPE]: {
          actionNames: ["SOURCE_OWNER"],
          canDefer: () => bindingCurrent,
        },
      };
      const context: ContextObject = {
        id: "owned-request",
        metadata: { providerDiscoveryEnabled: true },
        events: [source],
      };
      const execute = vi.fn(async (_call: PlannerToolCall) => ({
        success: true,
        verifiedUserFacing: true,
        userFacingText: "Complete.",
        text: "Complete.",
        turnComplete: true,
      }));
      let calls = 0;
      const result = await runPlannerLoop({
        context,
        tools: [
          { name: operation },
          ...(operation === "MIXED_OPERATIONS"
            ? [{ name: "SOURCE_OWNER" }]
            : []),
        ],
        runtime: {
          // Fresh composeState providers may disappear after reauthorization;
          // the exact host-authored source must survive that refresh.
          restoreProviderContext: async (original) => ({
            ...original,
            events: original.events.filter(
              (event) => event.source !== "composeState",
            ),
          }),
          useModel: async (_type, params) => {
            calls++;
            const canonical = (
              params as typeof params & {
                [MODEL_CANONICAL_CONTEXT]?: ContextObject;
              }
            )[MODEL_CANONICAL_CONTEXT];
            expect(canonical?.events[0]).toBe(source);
            expect(source.text).toBe(originalText);
            const input = params.messages
              .map((message) => message.content)
              .join("\n");
            if (calls === 1) {
              expect(input).toContain(source.discoveryText);
              expect(input).not.toContain("Literal controls:");
            } else {
              expect(input).toContain(originalText);
              expect(execute).not.toHaveBeenCalled();
            }
            if (calls === 1 && operation === "VIEW_CHANGES_DURING_MODEL")
              bindingCurrent = false;
            return {
              text:
                calls === 1 && operation !== "SOURCE_OWNER"
                  ? "Old prose must never be delivered."
                  : "",
              toolCalls: [
                ...(calls === 1 && operation === "MIXED_OPERATIONS"
                  ? [
                      {
                        id: "must-not-execute",
                        name: "SOURCE_OWNER",
                        arguments: {},
                      },
                    ]
                  : []),
                { id: `operation-${calls}`, name: operation, arguments: {} },
              ],
            };
          },
        },
        executeToolCall: execute,
        evaluate: async () => ({
          decision: "FINISH",
          success: true,
          messageToUser: "Complete.",
        }),
      });
      expect(calls).toBe(operation === "SOURCE_OWNER" ? 1 : 2);
      expect(execute).toHaveBeenCalledTimes(1);
      expect(execute.mock.calls[0]?.[0].id).toBe(
        `operation-${operation === "SOURCE_OWNER" ? 1 : 2}`,
      );
      expect(result.finalMessage).toBe("Complete.");
      expect(result.trajectory.modelBaseContext?.events[0]).toBe(source);
      expect(source.text).toBe(originalText);
    },
  );
});
