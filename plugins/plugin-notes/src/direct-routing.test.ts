import {
  AgentRuntime,
  getDirectActionRoutingRules,
  type Memory,
  type ResponseHandlerEvaluatorContext,
} from "@elizaos/core";
import { describe, expect, it } from "vitest";
import {
  BUILTIN_RESPONSE_HANDLER_EVALUATORS,
  resolveEligibleDirectActionRoutes,
} from "../../plugin-assistant/src/services/message/stage1-evaluators";
import { notesPlugin } from "./plugin";

const request =
  "Create a note with exactly these two lines:\nQA latest regression\nThe verification word is cobalt.";
async function context(
  actions = notesPlugin.actions ?? [],
): Promise<ResponseHandlerEvaluatorContext> {
  const runtime = new AgentRuntime({
    character: { name: "Notes routing", bio: [] },
    logLevel: "fatal",
  });
  for (const action of actions) runtime.registerAction(action);
  await notesPlugin.init?.({}, runtime);
  return {
    runtime,
    message: {
      content: { text: request, source: "client_chat", channelType: "DM" },
    } as Memory,
    state: { text: "", values: {}, data: {} },
    messageHandler: {
      processMessage: "RESPOND",
      thought: "",
      plan: {
        contexts: ["simple"],
        reply: "I can't save without a renderer.",
        simple: true,
      },
    },
    availableContexts: [],
    userRoles: ["OWNER"],
  };
}
describe("Notes creation capability routing", () => {
  it("overrides the captured renderer-denial route through the registered backend capability", async () => {
    const ctx = await context();
    const routes = await resolveEligibleDirectActionRoutes(ctx);
    expect(routes.map((r) => r.action.name)).toContain("NOTES_CREATE");
    const evaluator = BUILTIN_RESPONSE_HANDLER_EVALUATORS.find(
      (e) => e.name === "core.direct_registered_capability_request",
    );
    expect(evaluator).toBeDefined();
    if (!evaluator) throw new Error("Missing registered routing evaluator");
    const patch = await evaluator.evaluate(ctx);
    expect(patch).toMatchObject({
      requiresTool: true,
      clearReply: true,
      addContexts: ["notes"],
      addCandidateActions: ["NOTES_CREATE"],
    });
  });
  it.each([
    "Please create a note titled Test with body Hello.",
    "Save a note: Hello.",
    "Add a new note: Hello.",
  ])("recognizes a direct creation request: %s", async (text) => {
    const ctx = await context();
    const route = getDirectActionRoutingRules(ctx.runtime).find(
      (r) => r.id === "notes.create",
    );
    expect(route?.matches(text)).toBe(true);
  });
  it.each([
    "Don't create a note.",
    "Explain how to create a note.",
    "The user said create a note.",
    "Read my notes.",
    "Delete a note.",
    "Create a story about notes.",
    "Write a note to Shaw.",
  ])("does not claim adjacent or reported work: %s", async (text) => {
    const ctx = await context();
    const route = getDirectActionRoutingRules(ctx.runtime).find(
      (r) => r.id === "notes.create",
    );
    expect(route).toBeDefined();
    if (!route) throw new Error("Missing Notes creation routing rule");
    expect(route.matches(text)).toBe(false);
  });
  it("keeps owner permission and capability availability gates", async () => {
    const ctx = await context();
    expect(
      await resolveEligibleDirectActionRoutes({ ...ctx, userRoles: ["USER"] }),
    ).toEqual([]);
    expect(await resolveEligibleDirectActionRoutes(await context([]))).toEqual(
      [],
    );
  });
  it("routes the captured explicit read through the current-record reader", async () => {
    const ctx = await context();
    ctx.message.content.text = "Read the note titled QA latest regression.";
    const routes = await resolveEligibleDirectActionRoutes(ctx);
    expect(routes.map((r) => r.action.name)).toEqual(["NOTES_LIST"]);
    expect(
      await resolveEligibleDirectActionRoutes({ ...ctx, userRoles: ["USER"] }),
    ).toEqual([]);
  });
  it.each([
    "What did I just write?",
    "Explain how to read notes.",
    "The user said read my notes.",
    "Read a story about notes.",
  ])("leaves ordinary recall and noncommands unchanged: %s", async (text) => {
    const ctx = await context();
    ctx.message.content.text = text;
    expect(await resolveEligibleDirectActionRoutes(ctx)).toEqual([]);
  });
});
