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

  it("matches planner-invented LifeOps aliases to LIFE benchmark cases", () => {
    expect(caseMatches("ADD_TODO", "LIFE", undefined)).toBe(true);
    expect(caseMatches("ADD_HABIT", "LIFE", undefined)).toBe(true);
    expect(caseMatches("CREATE_HABIT", "LIFE", ["CREATE_HABIT"])).toBe(true);
    expect(caseMatches("LIST_TODOS", "LIFE", ["LIST_TODOS"])).toBe(true);
    expect(caseMatches("LIFE.add_goal", "LIFE", undefined)).toBe(true);
  });

  it("matches specialized computer-use tools to COMPUTER_USE", () => {
    expect(caseMatches("FILE_ACTION", "COMPUTER_USE", undefined)).toBe(true);
    expect(caseMatches("TERMINAL_ACTION", "COMPUTER_USE", undefined)).toBe(
      true,
    );
  });

  it("matches planner aliases for social and focus actions", () => {
    expect(caseMatches("SOCIAL_POSTING", "POST", undefined)).toBe(true);
    expect(caseMatches("GET_TIMELINE", "POST", undefined)).toBe(true);
    expect(caseMatches("SEARCH_TWITTER", "POST", undefined)).toBe(true);
    expect(caseMatches("SEARCH_TWITTER_POSTS", "POST", undefined)).toBe(true);
    expect(caseMatches("FETCH_TWITTER_DMS", "MESSAGE", undefined)).toBe(true);
    expect(caseMatches("READ_TWITTER_DM", "MESSAGE", undefined)).toBe(true);
    expect(caseMatches("EMAIL_FETCH_UNREAD", "MESSAGE", undefined)).toBe(true);
    expect(caseMatches("SEND_DISCORD_MESSAGE", "MESSAGE", undefined)).toBe(true);
    expect(caseMatches("BLOCK_WEBSITE", "WEBSITE_BLOCK", undefined)).toBe(true);
    expect(caseMatches("AUTOMATION_FOCUS_BLOCK", "WEBSITE_BLOCK", undefined)).toBe(
      true,
    );
    expect(caseMatches("PHONE_BLOCK_APPS", "APP_BLOCK", undefined)).toBe(true);
  });

  it("matches approval resolution aliases", () => {
    expect(caseMatches("ADMIN_REJECT_APPROVAL", "RESOLVE_REQUEST", undefined)).toBe(
      true,
    );
    expect(caseMatches("DENY_APPROVAL", "RESOLVE_REQUEST", undefined)).toBe(
      true,
    );
  });

  it("matches atomic device intent broadcast aliases", () => {
    expect(caseMatches("BROADCAST_INTENT", "DEVICE_INTENT", undefined)).toBe(
      true,
    );
    expect(caseMatches("DEVICE_BROADCAST", "DEVICE_INTENT", undefined)).toBe(
      true,
    );
    expect(caseMatches("MOBILE_REMINDER", "DEVICE_INTENT", undefined)).toBe(
      true,
    );
  });

  it("matches check-in aliases to the restored check-in action", () => {
    expect(caseMatches("LIFE_CHECK_IN", "CHECKIN", undefined)).toBe(true);
    expect(caseMatches("MORNING_CHECK_IN", "CHECKIN", undefined)).toBe(true);
    expect(caseMatches("NIGHT_CHECKIN", "CHECKIN", undefined)).toBe(true);
    expect(caseMatches("AUTOMATION_RUN", "CHECKIN", undefined)).toBe(true);
  });

  it("matches generic memory set aliases to the profile action", () => {
    expect(caseMatches("MEMORY_SET", "PROFILE", undefined)).toBe(true);
    expect(caseMatches("MEMORY_WRITE", "PROFILE", undefined)).toBe(true);
  });

  it("matches task and desktop atomic aliases to parent benchmark actions", () => {
    expect(caseMatches("TASKS_ADD_TODO", "LIFE", undefined)).toBe(true);
    expect(caseMatches("TODO_CREATE", "LIFE", undefined)).toBe(true);
    expect(caseMatches("TODOS_CREATE", "LIFE", undefined)).toBe(true);
    expect(caseMatches("TASK_LIST", "LIFE", undefined)).toBe(true);
    expect(caseMatches("TASKS_LIST_TODAY", "LIFE", undefined)).toBe(true);
    expect(caseMatches("TASKS_SET_GOAL", "LIFE", undefined)).toBe(true);
    expect(caseMatches("LIST_TASKS", "LIFE", undefined)).toBe(true);
    expect(caseMatches("SET_GOAL", "LIFE", undefined)).toBe(true);
    expect(caseMatches("DESKTOP", "COMPUTER_USE", undefined)).toBe(true);
  });

  it("ignores background evaluator actions when picking the observed action", () => {
    const observed = pickObservedAction(
      [
        { phase: "completed", actionName: "RELATIONSHIP_EXTRACTION" },
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
        { phase: "completed", actionName: "RELATIONSHIP_EXTRACTION" },
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

    expect(planned).toEqual(["LIFE"]);
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

    expect(planned).toEqual(["LIFE"]);
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
