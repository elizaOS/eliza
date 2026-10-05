import { ModelType, type UUID } from "@elizaos/core/protocol";
import { describe, expect, it, vi } from "vitest";
import {
  makeMessage,
  makeRuntime,
  runStage1,
  stage1Response,
  useModelCalls,
} from "./fixtures.js";

// A sub-agent completion relay's envelope echoes the ORIGINAL task text
// ("[sub-agent: Build and deploy…]"), so the direct-candidate injection
// backstop used to read a FINISHED task as fresh task intent: it forced
// requiresTool + a delegation candidate onto the relay turn, the planner
// rejected REPLY up to the required-tool miss cap, and some turns re-spawned
// the already-completed task. Relay turns are detected by their structural
// markers (content.metadata.subAgent / the relay envelope prefix), never by
// classifying LLM text — genuine user task-intent turns keep the backstop.
describe("sub-agent completion relay vs the direct-candidate injection backstop", () => {
  const RELAY_ENVELOPE_TEXT =
    "[sub-agent: Build and deploy a dice roller web app (opencode) — completed]\n" +
    "Done. I built the dice roller web app and deployed it. " +
    "The app is live at https://apps.example.test/dice/ — repo updated on branch feat/dice.";

  function makeSpawnAction(handler: () => Promise<unknown>) {
    return {
      name: "TASKS_SPAWN_AGENT",
      similes: [],
      tags: ["domain:coding", "resource:agent-task", "capability:delegate"],
      description: "Spawn a coding sub-agent for a delegated task.",
      parameters: [
        {
          name: "task",
          description: "Task description",
          required: true,
          schema: { type: "string" },
        },
      ],
      examples: [],
      validate: async () => true,
      handler,
    };
  }

  it("lets REPLY through on a metadata-marked relay turn (structured Stage 1) — no force-tools, no re-spawn", async () => {
    const spawnHandler = vi.fn(async () => ({
      success: true,
      text: "spawned",
      data: { actionName: "TASKS_SPAWN_AGENT" },
    }));
    // A terse relay reply fails looksLikeCompleteDirectReply, so nothing but
    // the relay gate itself keeps the injection backstop off this turn — the
    // exact shape that used to be force-planned into the miss-cap loop.
    const runtime = makeRuntime([
      stage1Response({
        contexts: ["simple"],
        replyText: "Done.",
        extra: { replyEffectStatus: "pending" },
      }),
    ]);
    runtime.actions = [makeSpawnAction(spawnHandler)] as never;

    const result = await runStage1({
      runtime,
      message: makeMessage({
        text: RELAY_ENVELOPE_TEXT,
        source: "sub_agent",
        metadata: { subAgent: true },
      }),
    });

    expect(result.kind).toBe("direct_reply");
    expect(result.messageHandler.plan.requiresTool).toBe(false);
    expect(result.messageHandler.plan.candidateActions ?? []).not.toContain(
      "TASKS_SPAWN_AGENT",
    );
    expect(spawnHandler).not.toHaveBeenCalled();
    // Stage 1 only — no planner stage, no required-tool miss loop.
    expect(useModelCalls(runtime)).toHaveLength(1);
    if (result.kind === "direct_reply") {
      expect(result.result.responseContent?.text).toBe("Done.");
    }
  });

  it("lets REPLY through on a canonical relay turn (plain-text Stage 1 fallback)", async () => {
    const spawnHandler = vi.fn(async () => ({
      success: true,
      text: "spawned",
      data: { actionName: "TASKS_SPAWN_AGENT" },
    }));
    // Plain-text Stage 1 output exercises the
    // applyDirectCurrentCandidateBackstopToMessageHandler path; the canonical
    // source and metadata pair keeps unilateral spoofable markers untrusted.
    const runtime = makeRuntime([
      "Build finished — the dice roller app is deployed and the link was shared above.",
    ]);
    runtime.actions = [makeSpawnAction(spawnHandler)] as never;

    const result = await runStage1({
      runtime,
      message: makeMessage({
        text: RELAY_ENVELOPE_TEXT,
        source: "sub_agent",
        metadata: { subAgent: true },
      }),
    });

    expect(result.kind).toBe("direct_reply");
    // The plain-text synthesizer leaves requiresTool unset; the defect was
    // the backstop PROMOTING it to true — assert the promotion never happens.
    expect(result.messageHandler.plan.requiresTool).not.toBe(true);
    expect(result.messageHandler.plan.candidateActions ?? []).not.toContain(
      "TASKS_SPAWN_AGENT",
    );
    expect(spawnHandler).not.toHaveBeenCalled();
    expect(useModelCalls(runtime)).toHaveLength(1);
  });

  it("keeps the backstop on a genuine user task-intent turn with the same task words", async () => {
    const spawnHandler = vi.fn(async () => ({
      success: true,
      text: "sub-agent session started",
      data: { actionName: "TASKS_SPAWN_AGENT" },
    }));
    const runtime = makeRuntime([
      stage1Response({
        contexts: [],
        replyText: "On it.",
      }),
      {
        thought: "Delegate the build to a coding sub-agent.",
        toolCalls: [
          {
            id: "spawn-1",
            name: "TASKS_SPAWN_AGENT",
            arguments: { task: "Build and deploy a dice roller web app" },
          },
        ],
      },
      JSON.stringify({
        success: true,
        decision: "FINISH",
        thought: "Sub-agent spawned.",
        messageToUser: "Spawned a coding agent to build the dice roller.",
      }),
    ]);
    runtime.actions = [makeSpawnAction(spawnHandler)] as never;

    const message = makeMessage();
    message.content = {
      ...message.content,
      text: "Build and deploy a dice roller web app",
      mentionContext: { isMention: true },
    };

    const result = await runStage1({
      runtime,
      message,
    });

    expect(result.kind).toBe("planned_reply");
    expect(spawnHandler).toHaveBeenCalledTimes(1);
    const calls = useModelCalls(runtime);
    expect(calls[1]?.[0]).toBe(ModelType.ACTION_PLANNER);
    const plannerCall = calls[1]?.[1] as {
      messages?: Array<{ role?: string; content?: string | null }>;
    };
    const plannerUserContent = plannerCall.messages?.[1]?.content ?? "";
    expect(plannerUserContent).toContain('"requiresTool":true');
    expect(plannerUserContent).toContain(
      '"candidateActions":["TASKS_SPAWN_AGENT"]',
    );
  });

  it("routes a simple turn into planning when a response-handler evaluator promotes it", async () => {
    // Stage 1 fully answers; a registered response-handler evaluator patches
    // the plan (requiresTool + a replacement reply). The turn must reach the
    // planner with the patch applied — the promotion mechanism the
    // answer-clobber rescue exists to make safe.
    const runtime = makeRuntime(
      [
        stage1Response({
          contexts: ["general"],
          replyText: "The answer is 42.",
        }),
        { text: "", toolCalls: [] },
        JSON.stringify({
          success: true,
          decision: "FINISH",
          thought: "Nothing further.",
          messageToUser: "",
        }),
      ],
      undefined,
      [
        {
          name: "test-promotion",
          priority: 100,
          shouldRun: () => true,
          evaluate: () => ({ reply: "On it.", requiresTool: true }),
        },
      ],
    );

    const result = await runStage1({
      runtime,
      message: makeMessage(),
    });

    // The evaluator patch replaced the stage-1 reply and forced planning.
    expect(result.messageHandler.plan.reply).toBe("On it.");
    expect(result.messageHandler.plan.requiresTool).toBe(true);
    const calls = useModelCalls(runtime);
    expect(calls[1]?.[0]).toBe(ModelType.ACTION_PLANNER);
  });

  it("tells a fired prompt-automation that its reply is the automation's output, not an acknowledgement", async () => {
    // Live incident 2026-08-05 01:00: a "take vitamins" reminder fired and
    // the turn replied "noted." — the model read the trigger's own
    // "Do this now:" framing as a status message about itself and
    // acknowledged it, so the user received an acknowledgement instead of
    // the reminder. The policy is gated on the connector-set source, never
    // on message text.
    const runtime = makeRuntime([
      stage1Response({
        thought: "Automation fired.",
        contexts: ["general"],
        replyText: "time to take your vitamins.",
      }),
    ]);
    await runStage1({
      runtime,
      message: makeMessage({
        text: 'Scheduled trigger "take vitamins" fired. Do this now: remind me to take my vitamins',
        source: "trigger-prompt",
      }),
      responseId: "00000000-0000-0000-0000-0000000000aa" as UUID,
    });

    const stage1Call = useModelCalls(runtime)[0]?.[1] as
      | { messages?: Array<{ content?: string | null }> }
      | undefined;
    const stage1Content = (stage1Call?.messages ?? [])
      .map((entry) => entry.content ?? "")
      .join("\n");
    expect(stage1Content.match(/trigger_automation_policy:/g)).toHaveLength(1);
    expect(stage1Content).toContain(
      "whatever you reply is delivered to the user",
    );
    expect(stage1Content).toContain("Never reply with an acknowledgement");
  });

  it("keeps the prompt byte-identical for an ordinary user turn (no automation policy)", async () => {
    const runtime = makeRuntime([
      stage1Response({
        thought: "Ordinary turn.",
        contexts: ["general"],
        replyText: "sure.",
      }),
    ]);
    await runStage1({
      runtime,
      message: makeMessage({ text: "remind me to take my vitamins" }),
      responseId: "00000000-0000-0000-0000-0000000000ab" as UUID,
    });
    const stage1Call = useModelCalls(runtime)[0]?.[1] as
      | { messages?: Array<{ content?: string | null }> }
      | undefined;
    const stage1Content = (stage1Call?.messages ?? [])
      .map((entry) => entry.content ?? "")
      .join("\n");
    expect(stage1Content).not.toContain("trigger_automation_policy");
  });
});
