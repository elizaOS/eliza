/**
 * A dispatch-only native browser reload through the whole message pipeline.
 * Live Pixel v619: "reload the page" ended in the synthetic "part of it may
 * already be done" failure because every planner reply was rejected for
 * claiming an applied change the receipt never proved. The turn must now end
 * on the tool's own honest text, whatever completion claim the planner and
 * evaluator write.
 */
import type { Action } from "@elizaos/core";
import { ChannelType } from "@elizaos/core/protocol";
import { describe, expect, it, vi } from "vitest";
import {
  makeMessage,
  makeRuntime,
  runStage1,
  stage1Response,
} from "../../__tests__/stage1/fixtures.js";

const RELOAD_TEXT =
  "I asked the browser to reload the page. It may still be loading.";

const COMPLETION_CLAIMS = [
  "Reloaded the page.",
  "The page has finished reloading.",
];

/** The result plugin-browser's native handler returns for a dispatched reload. */
function dispatchedReload() {
  const result = {
    targetId: "native-client",
    mode: "web",
    subaction: "reload",
    value: { dispatched: true, completed: false, requiresReadback: false },
  };
  return {
    success: true,
    text: JSON.stringify(result),
    userFacingText: RELOAD_TEXT,
    verifiedUserFacing: true,
    turnComplete: true,
    data: { actionName: "BROWSER", executionStatus: "dispatched", result },
  };
}

/** The unchanged result the native handler returns for a dispatched click. */
function dispatchedClick() {
  const result = {
    targetId: "native-client",
    mode: "web",
    subaction: "click",
    value: { dispatched: true, completed: false, requiresReadback: true },
  };
  return {
    success: true,
    text: JSON.stringify(result),
    data: { actionName: "BROWSER", result },
  };
}

const browserAction = (handler: Action["handler"]): Action => ({
  name: "BROWSER",
  description: "Control the requesting phone's browser.",
  contexts: ["general"],
  parameters: [
    {
      name: "action",
      description: "Browser command.",
      schema: { type: "string", enum: ["back", "forward", "reload", "click"] },
    },
  ],
  validate: async () => true,
  handler,
});

async function browserTurn(
  claim: string,
  command: "reload" | "click" = "reload",
) {
  const runtime = makeRuntime([]);
  runtime.actions = [
    browserAction(async () =>
      command === "reload" ? dispatchedReload() : dispatchedClick(),
    ),
  ];
  const enums: unknown[][] = [];
  let plannerCalls = 0;
  runtime.useModel = vi.fn(
    async (
      _type: unknown,
      args: {
        tools?: Array<{ name?: string }>;
        responseSchema?: {
          properties?: { replyEffectStatus?: { enum?: unknown[] } };
        };
      },
    ) => {
      if (args.tools?.some((tool) => tool.name === "HANDLE_RESPONSE"))
        return stage1Response({
          contexts: ["general"],
          intents: [command === "reload" ? "Reload the page" : "Tap Submit"],
          candidateActionNames: ["BROWSER"],
          extra: { requiresTool: true },
        });
      const status = args.responseSchema?.properties?.replyEffectStatus;
      if (status) {
        const allowed = status.enum ?? [];
        enums.push(allowed);
        return JSON.stringify({
          thought: "The browser command ran.",
          success: true,
          decision: "FINISH",
          requestFullyCovered: true,
          replyEffectStatus: allowed.includes("applied") ? "applied" : "none",
          messageToUser: claim,
        });
      }
      if (plannerCalls++ === 0)
        return {
          text: claim,
          toolCalls: [
            {
              id: "call-1",
              name: "BROWSER",
              arguments: { action: command, eliza_turn_scope: "final" },
            },
          ],
        };
      return JSON.stringify({
        completed: true,
        toolCalls: [],
        messageToUser: claim,
      });
    },
  ) as never;
  const result = await runStage1({
    runtime,
    message: makeMessage({
      text: command === "reload" ? "reload the page" : "tap submit",
      channelType: ChannelType.DM,
    }),
  });
  return { result, enums };
}

describe("dispatched browser reload through the message pipeline", () => {
  it.each(COMPLETION_CLAIMS)(
    "replies with the tool's honest text when the model would say %j",
    async (claim) => {
      const { result, enums } = await browserTurn(claim);
      expect(enums.length).toBeGreaterThan(0);
      for (const allowed of enums) expect(allowed).not.toContain("applied");
      expect(result.kind).toBe("planned_reply");
      const reply =
        result.kind === "planned_reply" || result.kind === "direct_reply"
          ? result.result
          : undefined;
      expect(reply?.terminalFailure).toBeUndefined();
      expect(reply?.responseContent?.text).toBe(RELOAD_TEXT);
      for (const other of COMPLETION_CLAIMS)
        expect(reply?.responseContent?.text).not.toContain(other);
    },
  );

  it("keeps the failure notice for a dispatched click the guard cannot ground", async () => {
    const { result, enums } = await browserTurn("Tapped Submit.", "click");
    expect(enums.length).toBeGreaterThan(1);
    for (const allowed of enums) expect(allowed).toContain("applied");
    expect(result.kind).toBe("direct_reply");
    const reply = result.kind === "direct_reply" ? result.result : undefined;
    expect(reply?.terminalFailure).toMatchObject({
      code: "PLANNER_INTERRUPTED_AFTER_ACTION",
    });
    expect(reply?.responseContent?.text).not.toContain("Tapped Submit.");
  });
});
