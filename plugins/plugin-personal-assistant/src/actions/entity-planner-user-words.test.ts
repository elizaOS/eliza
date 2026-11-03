/**
 * ENTITY planner must read the user's words, not the envelope.
 *
 * resolveEntityPlanWithLlm() builds its prompt from the raw message text:
 * the "Current request" section and the resolved intent both carry the
 * document-augmentation envelope when the turn is augmented. A person named
 * only in a recalled document (here, Sam) can therefore steer the planner
 * even when the user's own request is just "Show my contacts."
 * After the fix, both inputs read getUserMessageText, which strips the
 * document-augmentation wrapper.
 */
import type { IAgentRuntime, Memory } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";

import { entityAction } from "./entity";

const AUGMENTED_TEXT = [
  "Answer the user request using the contextual documents below as the source of truth when they contain the answer.",
  "",
  "<contextual_documents>",
  '<source title="team notes" similarity="0.900">',
  "Sam works at Acme.",
  "</source>",
  "</contextual_documents>",
  "",
  "<user_request>",
  "Show my contacts.",
  "</user_request>",
].join("\n");

describe("entityAction planner user words", () => {
  it("does not send a document fragment to the ENTITY planner", async () => {
    const prompts: string[] = [];
    const runtime = {
      agentId: "agent-1",
      useModel: vi.fn(async (_type: unknown, opts: { prompt?: string }) => {
        prompts.push(opts.prompt ?? "");
        return JSON.stringify({
          action: null,
          shouldAct: false,
          response: "Tell me whether you want to list contacts.",
          intent: null,
          name: null,
          channel: null,
          handle: null,
          email: null,
          phone: null,
          notes: null,
          relationshipId: null,
          reason: null,
          toEntityId: null,
          fromEntityId: null,
          relationshipType: null,
          evidence: null,
        });
      }),
      logger: {
        warn: vi.fn(),
        info: vi.fn(),
        debug: vi.fn(),
        error: vi.fn(),
      },
    } as unknown as IAgentRuntime;
    const message = {
      entityId: "agent-1",
      roomId: "room-1",
      content: { text: AUGMENTED_TEXT },
    } as unknown as Memory;
    await entityAction.handler(runtime, message, undefined, {
      parameters: {},
    });
    expect(prompts.length).toBeGreaterThan(0);
    const plannerPrompt = prompts[0] ?? "";
    expect(plannerPrompt).toContain("Show my contacts.");
    expect(plannerPrompt).not.toContain("Sam works at Acme.");
    expect(plannerPrompt).not.toContain(
      "Answer the user request using the contextual documents",
    );
  });
});
