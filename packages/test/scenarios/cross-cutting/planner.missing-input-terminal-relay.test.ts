/**
 * Pins the missing-input live scenario's action provenance before credentialed
 * execution so parent and generated child routes share the same strict result bar.
 */

import type { CapturedAction } from "@elizaos/scenario-runner/schema";
import { describe, expect, test } from "vitest";
import { expectMissingInputTerminalRelay } from "./planner.missing-input-terminal-relay.assertion";

const CLARIFICATION =
  "What’s the report name, what day is it due, and what time should I use?";

function action(
  actionName: string,
  overrides: Partial<NonNullable<CapturedAction["result"]>> = {},
): CapturedAction {
  return {
    actionName,
    result: {
      success: true,
      data: { awaitingUserInput: true },
      raw: { userFacingText: CLARIFICATION },
      ...overrides,
    },
  };
}

function evaluate(candidate: CapturedAction, responseText = CLARIFICATION) {
  return expectMissingInputTerminalRelay({
    actionsCalled: [candidate],
    responseText,
  });
}

describe("missing-input terminal relay scenario", () => {
  test("accepts the parent reminder action", () => {
    expect(evaluate(action("OWNER_REMINDERS"))).toBeUndefined();
  });

  test("accepts the generated reminder-create child", () => {
    expect(evaluate(action("OWNER_REMINDERS_CREATE"))).toBeUndefined();
  });

  test("rejects an unrelated action even when its payload copies the markers", () => {
    expect(evaluate(action("OWNER_ROUTINES_CREATE"))).toMatch(
      /no reminder-create action executed/,
    );
  });

  test("requires successful execution and explicit missing-input authority", () => {
    expect(
      evaluate(action("OWNER_REMINDERS_CREATE", { success: false })),
    ).toMatch(/did not succeed/);
    expect(
      evaluate(
        action("OWNER_REMINDERS_CREATE", {
          data: { awaitingUserInput: false },
        }),
      ),
    ).toMatch(/lacked awaitingUserInput/);
  });

  test("rejects model paraphrase that is not a valid scheduling form", () => {
    expect(evaluate(action("OWNER_REMINDERS_CREATE"), "Tell me more.")).toMatch(
      /neither a scheduling form nor the action clarification/,
    );
  });
});
