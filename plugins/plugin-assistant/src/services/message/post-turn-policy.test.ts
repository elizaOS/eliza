import type { ActionResult, Memory, State } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { collectPreviousActionResults } from "./planned-tool.ts";
import { hasPostTurnSemanticSignal } from "./post-turn-policy.ts";

// Receipts as views.ts emits them and collectPreviousActionResults keeps them
// (QA trajectories tj-755bef36654c07 "Can you go home?", tj-9beeb81bb5a271).
const navigation = (
  actionName: "VIEWS" | "VIEWS_SHOW",
  viewId: string,
  label: string,
): ActionResult => {
  const receipt = {
    effect: "view_navigation",
    status: "prepared",
    viewId,
    path: `/${viewId}`,
    label,
    stepId: null,
    handoffId: "0afe696d-a77e-46b2-be2c-01ad779545ed",
  };
  return {
    success: true,
    text: JSON.stringify(receipt),
    transcriptVisibility: "internal",
    data: { actionName, awaitingDeviceExecution: true, navigation: receipt },
  };
};
const calendarCreate: ActionResult = {
  success: true,
  text: "Created event “qa lunch” today at 12:00 PM.",
  data: { actionName: "CALENDAR_CREATE_EVENT" },
};
// DISCOVER_ACTIONS load receipt (QA trajectory tj-a06f2e6bbb6688).
const discovery: ActionResult = {
  success: true,
  text: "Named tools enabled for execution with complete schemas in the current tool surface. No domain work or data mutation ran. Use those tools to continue the requested work.",
  transcriptVisibility: "internal",
  data: { actionName: "DISCOVER_ACTIONS", readOnlyOperation: true },
};

const signal = (
  text: string,
  actionResults: ActionResult[],
  extract?: { facts?: string[] },
) =>
  hasPostTurnSemanticSignal(
    { content: { text } } as Memory,
    { data: { actionResults } } as unknown as State,
    { actions: ["REPLY"] },
    extract,
  );

describe("hasPostTurnSemanticSignal", () => {
  it("schedules no memory review after a navigation-only turn", () => {
    expect(
      signal("Can you go home?", [navigation("VIEWS_SHOW", "chat", "Home")]),
    ).toBe(false);
    expect(signal("open notes", [navigation("VIEWS", "notes", "Notes")])).toBe(
      false,
    );
    // QA prompts: tj-785da77d4fc4b2, tj-a3ba2d1faf8f95.
    expect(
      signal("Open my calendar, please.", [
        navigation("VIEWS_SHOW", "calendar", "Calendar"),
      ]),
    ).toBe(false);
    expect(
      signal("show me my files", [navigation("VIEWS_SHOW", "files", "Files")]),
    ).toBe(false);
    // The planner may load the view action before it navigates.
    const steps = [
      { toolCall: { name: "DISCOVER_ACTIONS" }, result: discovery },
      {
        toolCall: { name: "VIEWS_SHOW" },
        result: navigation("VIEWS_SHOW", "notes", "Notes"),
      },
    ];
    expect(
      signal(
        "open notes",
        collectPreviousActionResults({
          archivedSteps: [],
          steps,
          context: { events: [] },
        } as never),
      ),
    ).toBe(false);
  });

  it("reads the user's words, not the help-document augmentation envelope", () => {
    // Shape packages/agent/src/api/chat-augmentation.ts writes into
    // content.text: "open" alone reaches the 0.5 term coverage, so short
    // navigation commands carry help fragments ("show my tasks"). Live
    // 2026-10-30 :5325, "open notes" / "open camera" / "go back" each still
    // queued a post-turn memory review.
    const augmented = (request: string) =>
      [
        "Answer the user request using the contextual documents below as the source of truth when they contain the answer.",
        "If the answer appears verbatim in the contextual documents, repeat it exactly.",
        "Do not ask follow-up questions or invoke tools/actions when the contextual documents already answer the request.",
        "",
        "<contextual_documents>",
        '<source title="source-1" similarity="1.000">',
        'Q: How do I switch screens or views?\nA: Two ways: tap a tile on the launcher screen, or just ask the chat — type or say things like "open settings", "go home", or "show my tasks" and Eliza navigates there for you.',
        "</source>",
        "</contextual_documents>",
        "",
        "<user_request>",
        request,
        "</user_request>",
      ].join("\n");
    expect(
      signal(augmented("open notes"), [navigation("VIEWS", "notes", "Notes")]),
    ).toBe(false);
    expect(
      signal(augmented("open camera"), [
        navigation("VIEWS", "camera", "Camera"),
      ]),
    ).toBe(false);
    expect(
      signal(augmented("open notes, I prefer week view"), [
        navigation("VIEWS", "notes", "Notes"),
      ]),
    ).toBe(true);
  });

  it("still schedules navigation turns that carry a recognized user signal", () => {
    const nav = [navigation("VIEWS_SHOW", "calendar", "Calendar")];
    expect(signal("Open the calendar, I prefer week view", nav)).toBe(true);
    expect(signal("Open my calendar, my wife starts Monday", nav)).toBe(true);
    expect(signal("Open calendar", nav, { facts: ["prefers week view"] })).toBe(
      true,
    );
  });

  it("keeps every non-navigation action result as a signal", () => {
    expect(signal("make event for today", [calendarCreate])).toBe(true);
    expect(
      signal("open calendar and add lunch", [
        navigation("VIEWS_SHOW", "calendar", "Calendar"),
        calendarCreate,
      ]),
    ).toBe(true);
    expect(signal("what can you do?", [discovery])).toBe(true);
    // A failed switch (views.ts fail()) carries no receipt text.
    expect(
      signal("open spotify", [
        {
          success: false,
          text: "No unique registered view matches. Use VIEWS action=list to inspect available views.",
          data: { actionName: "VIEWS" },
        },
      ]),
    ).toBe(true);
    expect(
      signal("Can you go home?", [
        {
          ...navigation("VIEWS_SHOW", "chat", "Home"),
          effectReceipts: [{} as never],
        },
      ]),
    ).toBe(true);
    expect(
      hasPostTurnSemanticSignal(
        { content: { text: "Can you go home?" } } as Memory,
        { data: { actionResults: [] } } as unknown as State,
        { actions: ["VIEWS_SHOW"] },
      ),
    ).toBe(true);
  });
});
