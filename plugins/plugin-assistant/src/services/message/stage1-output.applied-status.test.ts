/** Stage-1 "applied" classifies the reply's own completed-change claim. */
import { describe, expect, it } from "vitest";
import { routeMessageHandlerOutput } from "../../runtime/message-handler";
import {
  resolveSuppliedSourceReply,
  type SourceReplyRendering,
} from "./source-reply";
import { messageHandlerFromFieldResult } from "./stage1-output";

function route(fields: {
  replyText: string;
  intents?: string[];
  sourceReplyRendering?: SourceReplyRendering;
}) {
  return messageHandlerFromFieldResult(
    {
      shouldRespond: "RESPOND",
      contexts: ["simple"],
      intents: fields.intents ?? [],
      replyEffectStatus: "applied",
      replyText: fields.replyText,
      candidateActionNames: [],
      facts: [],
      relationships: [],
      addressedTo: [],
    },
    undefined,
    {
      actions: [],
      messageText: "Shipped all of this, here is the diff.",
      sourceReplyRendering: fields.sourceReplyRendering,
    },
  ).plan;
}

describe("an empty reply cannot carry applied", () => {
  it.each(["", " "])("reads applied on reply %j as pending", (replyText) => {
    expect(route({ replyText }).replyEffectStatus).toBe("pending");
  });

  it("pending declared work still requires a tool", () => {
    const plan = route({
      replyText: "",
      intents: ["review the alpha402 commit 18b9ff2 diff"],
    });
    expect(plan.replyEffectStatus).toBe("pending");
    expect(plan.requiresTool).toBe(true);
    expect(plan.reply).toBe("");
  });

  it("sends an empty applied reply with no declared work to the planner", () => {
    const plan = route({ replyText: "" });
    expect(
      routeMessageHandlerOutput(
        { processMessage: "RESPOND", thought: "", plan },
        { messageText: "save this note: buy milk" },
      ).type,
    ).toBe("planning_needed");
    expect(plan.replyEffectStatus).toBe("pending");
  });

  it("keeps applied on a source reply with no reply text", () => {
    expect(
      route({
        replyText: "",
        sourceReplyRendering: resolveSuppliedSourceReply(
          [{ kind: "source", value: "h1" }],
          { agentId: "agent", roomId: "room", messageId: "question" },
          [{ id: "h1", text: "Saved your note." }],
        ),
      }).replyEffectStatus,
    ).toBe("applied");
  });

  it("keeps applied on a reply that makes the claim", () => {
    expect(
      route({ replyText: "Saved your note.", intents: ["save the note"] })
        .replyEffectStatus,
    ).toBe("applied");
  });
});
