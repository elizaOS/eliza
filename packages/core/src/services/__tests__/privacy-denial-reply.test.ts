/**
 * Unit-tests privacyDenialReplyForReasons: the owner-private decline must be
 * accurate to WHY access was denied — an owner on a shared surface gets the
 * "ask me in a DM" routing hint, a non-owner gets a permission-truthful
 * decline with NO DM advice (a DM would be denied too), and role/context
 * gating states access is missing. Pure function, no runtime.
 */
import { describe, expect, test } from "vitest";
import { privacyDenialReplyForReasons } from "../message";

const R = (reason: string) => `Action OWNER_TODOS is not allowed: ${reason}`;

describe("privacyDenialReplyForReasons", () => {
  test("owner on a shared surface gets the DM routing hint", () => {
    const reply = privacyDenialReplyForReasons([
      R("Owner-private disclosure denied: participant_mismatch"),
    ]);
    expect(reply).toMatch(/dm/i);
    expect(reply).not.toMatch(/owner's private info/i);
  });

  test("non-owner gets a permission decline with NO DM advice", () => {
    const reply = privacyDenialReplyForReasons([
      R("Owner-private disclosure denied: owner_mismatch"),
    ]);
    expect(reply).toMatch(/owner's private info|only available to them/i);
    expect(reply).not.toMatch(/\bdm\b/i);
  });

  test("owner-on-surface takes precedence when both reasons appear", () => {
    const reply = privacyDenialReplyForReasons([
      R("Owner-private disclosure denied: participant_mismatch"),
      "Action TERMINAL_SHELL is not allowed for the current role",
    ]);
    expect(reply).toMatch(/dm/i);
  });

  test("role/context gating states missing access, not a surface", () => {
    const reply = privacyDenialReplyForReasons([
      "Action TERMINAL_SHELL is not allowed for the current role",
    ]);
    expect(reply).toMatch(/don't have access|limited to the owner/i);
    expect(reply).not.toMatch(/\bdm\b/i);
  });

  test("empty reasons still yields a non-empty honest decline", () => {
    expect(privacyDenialReplyForReasons([]).length).toBeGreaterThan(0);
  });
});
