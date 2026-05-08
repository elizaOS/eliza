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
    expect(caseMatches("BLOCK_WEBSITE", "WEBSITE_BLOCK", undefined)).toBe(true);
    expect(caseMatches("PHONE_BLOCK_APPS", "APP_BLOCK", undefined)).toBe(true);
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
