import { describe, expect, it } from "vitest";

import {
  caseMatches,
  parsePlannedActionsFromResponse,
  pickObservedAction,
} from "./action-selection-runner.ts";

describe("action selection benchmark scoring helpers", () => {
  it("matches provider-specific calendar action names to CALENDAR", () => {
    expect(caseMatches("GOOGLE_CALENDAR", "CALENDAR", undefined)).toBe(true);
    expect(caseMatches("CALENDLY", "CALENDAR", undefined)).toBe(true);
  });

  it("matches draft dispatch aliases to MESSAGE benchmark cases", () => {
    expect(caseMatches("MESSAGE", "MESSAGE", undefined)).toBe(true);
    expect(caseMatches("MESSAGE", "MESSAGE", ["MESSAGE"])).toBe(true);
    expect(caseMatches("DISPATCH_DRAFT", "MESSAGE", undefined)).toBe(true);
    expect(caseMatches("CONFIRM_AND_SEND", "MESSAGE", ["MESSAGE"])).toBe(true);
  });

  it("matches owner task, routine, and goal names to canonical benchmark cases", () => {
    expect(caseMatches("ADD_TODO", "OWNER_TODOS", undefined)).toBe(true);
    expect(caseMatches("ADD_HABIT", "OWNER_ROUTINES", undefined)).toBe(true);
    expect(caseMatches("CREATE_HABIT", "OWNER_ROUTINES", undefined)).toBe(
      true,
    );
    expect(caseMatches("LIST_TODOS", "OWNER_TODOS", undefined)).toBe(true);
    expect(caseMatches("ADD_GOAL", "OWNER_GOALS", undefined)).toBe(true);
  });

  it("does not collapse owner actions into the retired LIFE aggregate", () => {
    expect(caseMatches("ADD_TODO", "LIFE", undefined)).toBe(false);
    expect(caseMatches("ADD_HABIT", "LIFE", undefined)).toBe(false);
    expect(caseMatches("LIFE.add_goal", "OWNER_GOALS", undefined)).toBe(false);
  });

  it("matches specialized computer-use tools to COMPUTER_USE", () => {
    expect(caseMatches("FILE_ACTION", "COMPUTER_USE", undefined)).toBe(true);
    expect(caseMatches("TERMINAL_ACTION", "COMPUTER_USE", undefined)).toBe(
      true,
    );
  });

  it("matches planner aliases for social, messaging, and BLOCK", () => {
    expect(caseMatches("SOCIAL_POSTING", "POST", undefined)).toBe(true);
    expect(caseMatches("GET_TIMELINE", "POST", undefined)).toBe(true);
    expect(caseMatches("SEARCH_TWITTER", "POST", undefined)).toBe(true);
    expect(caseMatches("SEARCH_TWITTER_POSTS", "POST", undefined)).toBe(true);
    expect(caseMatches("FETCH_TWITTER_DMS", "MESSAGE", undefined)).toBe(true);
    expect(caseMatches("READ_TWITTER_DM", "MESSAGE", undefined)).toBe(true);
    expect(caseMatches("EMAIL_FETCH_UNREAD", "MESSAGE", undefined)).toBe(true);
    expect(caseMatches("SUMMARIZE_UNREAD_EMAILS", "MESSAGE", undefined)).toBe(
      true,
    );
    expect(caseMatches("SEND_DISCORD_MESSAGE", "MESSAGE", undefined)).toBe(true);
    // Post-consolidation: APP_BLOCK and WEBSITE_BLOCK both fold into BLOCK.
    expect(caseMatches("BLOCK_WEBSITE", "BLOCK", undefined)).toBe(true);
    expect(caseMatches("WEBSITE_BLOCK", "BLOCK", undefined)).toBe(true);
    expect(caseMatches("AUTOMATION_FOCUS_BLOCK", "BLOCK", undefined)).toBe(
      true,
    );
    expect(caseMatches("PHONE_BLOCK_APPS", "BLOCK", undefined)).toBe(true);
    expect(caseMatches("APP_BLOCK", "BLOCK", undefined)).toBe(true);
  });

  it("matches approval resolution aliases", () => {
    expect(caseMatches("ADMIN_REJECT_APPROVAL", "RESOLVE_REQUEST", undefined)).toBe(
      true,
    );
    expect(caseMatches("DENY_APPROVAL", "RESOLVE_REQUEST", undefined)).toBe(
      true,
    );
  });

  it("folds retired DEVICE_INTENT broadcast aliases into MESSAGE", () => {
    // DEVICE_INTENT was retired. Cross-device broadcasts now route through
    // MESSAGE; both the retired name and its broadcast aliases normalize
    // to MESSAGE so old captures still grade against the new surface.
    expect(caseMatches("BROADCAST_INTENT", "MESSAGE", undefined)).toBe(true);
    expect(caseMatches("DEVICE_BROADCAST", "MESSAGE", undefined)).toBe(true);
    expect(caseMatches("MOBILE_REMINDER", "MESSAGE", undefined)).toBe(true);
    expect(caseMatches("DEVICE_INTENT", "MESSAGE", undefined)).toBe(true);
  });

  it("keeps retired check-in aliases out of the benchmark action surface", () => {
    expect(caseMatches("LIFE_CHECK_IN", "CHECKIN", undefined)).toBe(false);
    expect(caseMatches("MORNING_CHECK_IN", "CHECKIN", undefined)).toBe(false);
    expect(caseMatches("NIGHT_CHECKIN", "CHECKIN", undefined)).toBe(false);
    expect(caseMatches("AUTOMATION_RUN", "CHECKIN", undefined)).toBe(false);
  });

  it("keeps retired memory aliases out of the benchmark action surface", () => {
    expect(caseMatches("MEMORY_SET", "PROFILE", undefined)).toBe(false);
    expect(caseMatches("MEMORY_WRITE", "PROFILE", undefined)).toBe(false);
  });

  it("folds retired owner-domain names into their post-consolidation parents", () => {
    // The 2026-05-10 audit split LIFE into per-domain owner parents and
    // retired RELATIONSHIP/HEALTH/SCREEN_TIME/SUBSCRIPTIONS/AUTOFILL/
    // PASSWORD_MANAGER/BOOK_TRAVEL/MANAGE_BROWSER_BRIDGE/DEVICE_INTENT.
    // Old captures with the retired top-level name must still grade
    // against the new surface.
    expect(caseMatches("RELATIONSHIP", "ENTITY", undefined)).toBe(true);
    expect(caseMatches("LIST_CONTACTS", "ENTITY", undefined)).toBe(true);
    expect(caseMatches("HEALTH", "OWNER_HEALTH", undefined)).toBe(true);
    expect(caseMatches("SCREEN_TIME", "OWNER_SCREENTIME", undefined)).toBe(
      true,
    );
    expect(caseMatches("BY_APP", "OWNER_SCREENTIME", undefined)).toBe(true);
    expect(caseMatches("SUBSCRIPTIONS", "OWNER_FINANCES", undefined)).toBe(
      true,
    );
    expect(caseMatches("AUTOFILL", "CREDENTIALS", undefined)).toBe(true);
    expect(caseMatches("PASSWORD_MANAGER", "CREDENTIALS", undefined)).toBe(
      true,
    );
    expect(caseMatches("BOOK_TRAVEL", "PERSONAL_ASSISTANT", undefined)).toBe(
      true,
    );
    expect(
      caseMatches("MANAGE_LIFEOPS_BROWSER", "BROWSER", undefined),
    ).toBe(true);
    expect(caseMatches("MANAGE_BROWSER_BRIDGE", "BROWSER", undefined)).toBe(
      true,
    );
  });

  it("matches task and desktop atomic names to canonical benchmark actions", () => {
    expect(caseMatches("TASKS_ADD_TODO", "OWNER_TODOS", undefined)).toBe(true);
    expect(caseMatches("TODO_CREATE", "OWNER_TODOS", undefined)).toBe(true);
    expect(caseMatches("TODOS_CREATE", "OWNER_TODOS", undefined)).toBe(true);
    expect(caseMatches("TASK_LIST", "OWNER_TODOS", undefined)).toBe(true);
    expect(caseMatches("TASKS_LIST_TODAY", "OWNER_TODOS", undefined)).toBe(
      true,
    );
    expect(caseMatches("TASKS_SET_GOAL", "OWNER_GOALS", undefined)).toBe(true);
    expect(caseMatches("LIST_TASKS", "OWNER_TODOS", undefined)).toBe(true);
    expect(caseMatches("SET_GOAL", "OWNER_GOALS", undefined)).toBe(true);
    expect(caseMatches("DESKTOP", "COMPUTER_USE", undefined)).toBe(true);
  });

  it("ignores background evaluator actions when picking the observed action", () => {
    const observed = pickObservedAction(
      [
        { phase: "completed", actionName: "REFLECTION" },
        {
          phase: "completed",
          actionName: "GOOGLE_CALENDAR",
          actionStatus: "failed",
        },
        { phase: "completed", actionName: "FACT_EXTRACTOR" },
      ],
      "completed",
      "CALENDAR",
      undefined,
    );

    expect(observed).toBe("GOOGLE_CALENDAR");
  });

  it("counts failed actions with pending human input as completed for execution scoring", () => {
    const observed = pickObservedAction(
      [
        {
          phase: "completed",
          actionName: "APP_BLOCK",
          actionStatus: "failed",
          actionConfirmationPending: true,
        },
      ],
      "completed",
      "APP_BLOCK",
      undefined,
      { requireSuccessfulCompletion: true },
    );

    expect(observed).toBe("APP_BLOCK");
  });

  it("does not count evaluator-only turns as real actions", () => {
    const observed = pickObservedAction(
      [
        { phase: "completed", actionName: "FACT_EXTRACTOR" },
        { phase: "completed", actionName: "REFLECTION" },
        { phase: "completed", actionName: "SKILL_LEARNING" },
      ],
      "completed",
      null,
      undefined,
    );

    expect(observed).toBeNull();
  });

  it("extracts AI SDK toolCalls from recorded native responses", () => {
    const planned = parsePlannedActionsFromResponse(
      JSON.stringify({
        text: "",
        toolCalls: [
          {
            toolCallId: "call-1",
            toolName: "GOOGLE_CALENDAR",
            input: { subaction: "next_event" },
          },
        ],
      }),
    );

    expect(planned).toEqual(["CALENDAR"]);
  });

  it("extracts bare JSON arrays of planner action records", () => {
    const planned = parsePlannedActionsFromResponse(
      `[{"name":"todo_create","arguments":{"title":"pick up dry cleaning","due":"2026-05-10"}}]`,
    );

    expect(planned).toEqual(["OWNER_TODOS"]);
  });

  it("extracts top-level tool records embedded in generated text", () => {
    const planned = parsePlannedActionsFromResponse(
      JSON.stringify({
        text: `{
  "tool": "create_todo",
  "arguments": {
    "title": "Pick up dry cleaning",
    "due_date": "2026-05-10"
  }
}Your todo has been added.`,
        toolCalls: [],
      }),
    );

    expect(planned).toEqual(["OWNER_TODOS"]);
  });

  it("unwraps native call_action tool calls to the selected action", () => {
    const planned = parsePlannedActionsFromResponse(
      JSON.stringify({
        text: "",
        toolCalls: [
          {
            toolCallId: "call-1",
            toolName: "call_action",
            input: {
              actionName: "MESSAGE",
              actionParameters: {},
            },
          },
        ],
      }),
    );

    expect(planned).toEqual(["MESSAGE"]);
  });

  it("unwraps native PLAN_ACTIONS tool calls to the selected action", () => {
    const planned = parsePlannedActionsFromResponse(
      JSON.stringify({
        text: "",
        toolCalls: [
          {
            toolCallId: "call-1",
            toolName: "PLAN_ACTIONS",
            input: {
              action: "MESSAGE",
              parameters: { operation: "triage" },
            },
          },
        ],
      }),
    );

    expect(planned).toEqual(["MESSAGE"]);
  });

  it("ignores message-handler protocol tool calls in planner scoring", () => {
    const planned = parsePlannedActionsFromResponse(
      JSON.stringify({
        text: "",
        toolCalls: [
          {
            toolCallId: "call-1",
            toolName: "HANDLE_RESPONSE",
            input: {
              processMessage: "RESPOND",
              plan: { contexts: ["email"] },
              thought: "Route to email.",
            },
          },
        ],
      }),
    );

    expect(planned).toEqual([]);
  });
});
