/** Exercises the real response/planner pipeline against a mutable role store and deterministic native model calls. */
import {
  ChannelType,
  type IAgentRuntime,
  type Memory,
  ModelType,
  ResponseHandlerFieldRegistry,
  type State,
  type UUID,
} from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { BUILTIN_RESPONSE_HANDLER_FIELD_EVALUATORS } from "../../runtime/builtin-field-evaluators";
import { resolveStage1SenderRole } from "./addressing";
import { runV5MessageRuntimeStage1 } from "./pipeline";

const id = (value: string) =>
  `00000000-0000-4000-8000-${value.padStart(12, "0")}` as UUID;

describe("discovery role refresh", () => {
  it.each([ChannelType.DM, ChannelType.VOICE_DM])(
    "withholds a revoked owner's schema during %s planning",
    async (channelType) => {
      const state: State = { values: {}, data: {}, text: "" };
      const message: Memory = {
        id: id("1"),
        entityId: id("2"),
        agentId: id("3"),
        roomId: id("4"),
        content: {
          text: "Inspect the owner record capability without running it.",
          source: "test",
          channelType,
        },
      };
      const world = {
        id: id("6"),
        agentId: id("3"),
        metadata: {
          roles: { [message.entityId]: "OWNER" },
          roleSources: { [message.entityId]: "manual" },
        },
      };
      const fields = new ResponseHandlerFieldRegistry();
      for (const field of BUILTIN_RESPONSE_HANDLER_FIELD_EVALUATORS)
        fields.register(field);
      let plannerCalls = 0;
      const completionRequests: string[] = [];
      const execute = vi.fn(async () => ({ success: true }));
      const privateDescription =
        "Owner schema includes PRIVATE_SCHEMA_SENTINEL.";
      const runtime = {
        agentId: id("3"),
        character: {
          name: "Test Agent",
          system: "Be concise.",
          bio: "Test assistant.",
        },
        actions: [
          {
            name: "OWNER_RECORD",
            description: privateDescription,
            contexts: ["general"],
            roleGate: { minRole: "OWNER" },
            parameters: [{ name: "secretField", schema: { type: "string" } }],
            handler: execute,
          },
        ],
        providers: [],
        getService: vi.fn(() => null),
        getRoom: vi.fn(async () => ({
          id: message.roomId,
          agentId: id("3"),
          worldId: world.id,
          type: channelType,
          source: "test",
        })),
        getWorld: vi.fn(async () => world),
        getModelRegistrations: vi.fn(() => []),
        composeState: vi.fn(async () => structuredClone(state)),
        runActionsByMode: vi.fn(async () => undefined),
        emitEvent: vi.fn(async () => undefined),
        reportError: vi.fn(),
        getSetting: vi.fn(),
        logger: {
          debug: vi.fn(),
          info: vi.fn(),
          warn: vi.fn(),
          error: vi.fn(),
          trace: vi.fn(),
        },
        responseHandlerFieldRegistry: fields,
        responseHandlerFieldEvaluators: fields.list(),
        responseHandlerEvaluators: [],
        useModel: vi.fn(async (type: string, request: object) => {
          if (type === ModelType.RESPONSE_HANDLER && plannerCalls === 0)
            return {
              text: "",
              toolCalls: [
                {
                  id: "handle",
                  name: "HANDLE_RESPONSE",
                  arguments: {
                    shouldRespond: "RESPOND",
                    contexts: ["general"],
                    intents: ["inspect the owner record schema"],
                    candidateActionNames: ["DISCOVER_TOOLS"],
                    contextRequests: [],
                    replyText: "",
                    replyEffectStatus: "none",
                    facts: [],
                    relationships: [],
                    addressedTo: [],
                    emotion: "none",
                  },
                },
              ],
            };
          if (type === ModelType.RESPONSE_HANDLER) {
            completionRequests.push(JSON.stringify(request));
            return JSON.stringify({
              decision: "FINISH",
              success: true,
              thought: "Current permission checks denied schema access.",
              messageToUser:
                "Your current permissions do not allow this capability.",
            });
          }
          if (type !== ModelType.ACTION_PLANNER)
            throw new Error(`Unexpected model ${type}`);
          plannerCalls++;
          if (plannerCalls === 1) {
            world.metadata.roles[message.entityId] = "GUEST";
            return {
              text: "",
              toolCalls: [
                {
                  id: "discover",
                  name: "DISCOVER_TOOLS",
                  arguments: {
                    names: ["OWNER_RECORD"],
                    mode: "describe",
                    eliza_turn_scope: "more_work_pending",
                  },
                },
              ],
            };
          }
          throw new Error("Unexpected additional planner call");
        }),
      } as unknown as IAgentRuntime;
      expect(await resolveStage1SenderRole(runtime, message)).toBe("OWNER");
      const result = await runV5MessageRuntimeStage1({
        runtime,
        message,
        state,
        responseId: id("5"),
      });
      expect(result.kind).toBe("planned_reply");
      expect(plannerCalls).toBe(1);
      expect(completionRequests).toHaveLength(1);
      expect(completionRequests[0]).not.toContain(privateDescription);
      expect(completionRequests[0]).not.toContain("secretField");
      expect(completionRequests[0]).toContain("not admitted");
      expect(execute).not.toHaveBeenCalled();
    },
  );
});
