import type { ActionResult, Memory, State } from "@elizaos/core";
import { describe, expect, it } from "vitest";
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
  });

  it("still schedules navigation turns that carry a recognized user signal", () => {
    const nav = [navigation("VIEWS_SHOW", "calendar", "Calendar")];
    expect(signal("Open the calendar, I prefer week view", nav)).toBe(true);
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
