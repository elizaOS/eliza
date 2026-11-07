import { expect, it, vi } from "vitest";
import { runPlannerLoop } from "../planner-loop.ts";

it.each([true, false])(
  "keeps a discovered native note query unexecuted until scope is explicit (repair: %s)",
  async (repair) => {
    const query = {
      operation: {
        type: "notes_query",
        query: { kind: "title", text: "Synthetic QA note" },
      },
      operationKey: "40d3011c-e111-4455-bb22-222222222222",
      reason: "Find the requested synthetic note for review.",
    };
    let requests = 0;
    const seen: unknown[] = [];
    const execute = vi.fn(async (call: { name: string; params?: unknown }) => {
      seen.push(call);
      return {
        success: true,
        text:
          call.name === "DISCOVER_ACTIONS"
            ? "Native notes query loaded."
            : "Awaiting note selection; no note has been shared.",
      };
    });
    const result = await runPlannerLoop({
      context: { id: "native-scope-repair", events: [] },
      tools: [
        {
          name: "DISCOVER_ACTIONS",
          parameters: {
            type: "object",
            properties: { names: { type: "array", items: { type: "string" } } },
            required: ["names"],
          },
        },
        {
          name: "PROPOSE_DEVICE_ACTION",
          parameters: {
            type: "object",
            properties: {
              operation: { type: "object" },
              operationKey: { type: "string" },
              reason: { type: "string" },
            },
            required: ["operation", "operationKey", "reason"],
          },
        },
      ],
      runtime: {
        useModel: async (_type, params) => {
          requests++;
          if (requests === 1)
            return {
              text: "",
              toolCalls: [
                {
                  id: "load",
                  name: "DISCOVER_ACTIONS",
                  arguments: {
                    names: ["PROPOSE_DEVICE_ACTION"],
                    eliza_turn_scope: "more_work_pending",
                  },
                },
              ],
            };
          if (requests === 3 && repair) {
            expect(JSON.stringify(params.messages)).toContain(
              "PLANNER_SCOPE_DECLARATION_REQUIRED",
            );
            return {
              text: "",
              toolCalls: [
                {
                  id: "query-repaired",
                  name: "PROPOSE_DEVICE_ACTION",
                  arguments: { ...query, eliza_turn_scope: "final" },
                },
              ],
            };
          }
          if (requests <= 3)
            return {
              text: "",
              toolCalls: [
                {
                  id: `query-missing-${requests}`,
                  name: "PROPOSE_DEVICE_ACTION",
                  arguments: query,
                },
              ],
            };
          return JSON.stringify({
            completed: false,
            toolCalls: [],
            messageToUser:
              "The note was not read; planning stopped before the query ran.",
          });
        },
      },
      executeToolCall: execute,
      evaluate: async () =>
        execute.mock.calls.length === 1
          ? { success: false, decision: "CONTINUE" as const }
          : {
              success: true,
              decision: "FINISH" as const,
              requestFullyCovered: false,
              messageToUser: "Choose the requested note to share it.",
            },
    });
    expect(seen).toHaveLength(repair ? 2 : 1);
    expect(seen[0]).toMatchObject({
      name: "DISCOVER_ACTIONS",
      params: { names: ["PROPOSE_DEVICE_ACTION"] },
    });
    if (repair) {
      expect(seen[1]).toMatchObject({
        name: "PROPOSE_DEVICE_ACTION",
        params: query,
      });
      expect(JSON.stringify(seen[1])).not.toContain("eliza_turn_scope");
    } else {
      expect(result.finalMessage).toContain("not read");
      expect(
        seen.some(
          (call) => (call as { name: string }).name === "PROPOSE_DEVICE_ACTION",
        ),
      ).toBe(false);
    }
  },
);
