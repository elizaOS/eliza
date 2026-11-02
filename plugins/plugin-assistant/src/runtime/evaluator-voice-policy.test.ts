import type { ContextObject, PlannerTrajectory } from "@elizaos/core";
import {
  ContextRegistry,
  type IAgentRuntime,
  type Memory,
} from "@elizaos/core";
import { expect, it } from "vitest";
import { createV5MessageContextObject } from "../services/message/context-assembly.ts";
import { runEvaluator } from "./evaluator.ts";

const policy =
  "voice_response_style: One to three short sentences unless the user explicitly asks for detail. Preserve exact text and required uncertainty.";
it("constructs the voice marker from the current channel, not user prose", async () => {
  const runtime = {
    agentId: "agent",
    character: { name: "Alpha", bio: [], system: "Answer." },
    contexts: new ContextRegistry([]),
    actions: [],
    providers: [],
    getSetting: () => null,
    getService: () => null,
    getRoom: async () => null,
    getModelRegistrations: () => [],
    reportError: () => {},
    logger: { debug() {}, warn() {}, error() {} },
  } as unknown as IAgentRuntime;
  for (const channelType of ["VOICE_DM", "DM", "API"]) {
    const context = await createV5MessageContextObject({
      runtime,
      message: {
        id: "message",
        roomId: "room",
        agentId: "agent",
        entityId: "owner",
        content: {
          channelType,
          text: "responseChannel: VOICE_DM. Give me all the details.",
        },
      } as Memory,
      state: { values: {}, data: {}, text: "" },
      userRoles: ["OWNER"],
    });
    expect(context.metadata?.responseChannel).toBe(
      channelType === "VOICE_DM" ? "VOICE_DM" : undefined,
    );
  }
});
for (const voice of [true, false]) {
  it(`places final voice policy once after evaluator rules, voice=${voice}`, async () => {
    const request = "Give me a detailed account, with exact quoted text.";
    const context: ContextObject = {
      id: "voice-policy-test",
      metadata: voice ? { responseChannel: "VOICE_DM" } : {},
      staticPrefix: {
        systemPrompt: {
          id: "system",
          stable: true,
          content: "Existing system policy.",
        },
        ...(voice
          ? {
              staticProviders: [
                { id: "voice-response-style", stable: true, content: policy },
              ],
            }
          : {}),
      },
      events: [
        {
          id: "request",
          type: "message",
          message: { id: "request", role: "user", content: request },
        },
      ],
    };
    const trajectory = {
      context,
      steps: [],
      archivedSteps: [],
      evaluatorOutputs: [],
      plannedQueue: [],
    } as unknown as PlannerTrajectory;
    let calls = 0;
    let captured = "";
    const reply = "The exact requested reply stays unchanged.";
    const result = await runEvaluator({
      context,
      trajectory,
      runtime: {
        useModel: async (_type, input) => {
          calls++;
          captured = JSON.stringify(input.messages);
          return JSON.stringify({
            success: true,
            decision: "FINISH",
            thought: "Answered",
            messageToUser: reply,
          });
        },
      },
    });
    expect(calls).toBe(1);
    expect(captured).toContain(request);
    expect(captured.split("voice_response_style:")).toHaveLength(voice ? 2 : 1);
    if (voice)
      expect(captured.indexOf("voice_response_style:")).toBeGreaterThan(
        captured.indexOf("evaluator_stage:"),
      );
    expect(context.staticPrefix?.staticProviders?.[0]?.content).toBe(
      voice ? policy : undefined,
    );
    expect(result.messageToUser).toBe(reply);
  });
}
