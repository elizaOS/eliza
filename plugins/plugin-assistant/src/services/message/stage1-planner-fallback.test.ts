/** Stage-1 planner fallback must read the user's words, not the document envelope. */
import { expect, it } from "vitest";
import { shouldUseStage1PlannerFallback } from "./stage1-generation.ts";

const runtime = {
  character: { name: "TestAgent", username: "testagent" },
  getSetting: () => undefined,
} as never;

function message(text: string) {
  return {
    content: { channelType: "GROUP", source: "discord", text },
    roomId: "room-1",
    entityId: "user-1",
  } as never;
}

const userWords = "what time is the meeting tomorrow";
const envelope = [
  "Answer the user request using the contextual documents below as the source of truth when they contain the answer.",
  "",
  "<contextual_documents>",
  `<source title="guide" similarity="0.900">`,
  "The TestAgent onboarding guide says new members should read this first.",
  "</source>",
  "</contextual_documents>",
  "",
  "<user_request>",
  userWords,
  "</user_request>",
].join("\n");

it("does not treat a document mention of the agent as the user addressing it", () => {
  expect(shouldUseStage1PlannerFallback(runtime, message(userWords))).toBe(
    false,
  );
  expect(shouldUseStage1PlannerFallback(runtime, message(envelope))).toBe(
    false,
  );
});

it("still falls back when the user's own words address the agent", () => {
  expect(
    shouldUseStage1PlannerFallback(
      runtime,
      message("TestAgent, what time is the meeting tomorrow"),
    ),
  ).toBe(true);
});
