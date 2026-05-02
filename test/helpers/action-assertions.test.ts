/**
 * Unit tests for E2E action assertion helpers.
 *
 * Verifies that the assertion utilities work correctly with synthetic
 * ActionInvocation data. These tests do NOT require a live runtime --
 * they exercise the pure-logic helpers (expectActionCalled, etc.) using
 * hand-crafted invocation arrays.
 *
 * getActionInvocations is tested indirectly via the live E2E suite since
 * it requires a real runtime with persisted memories.
 */

import type { Memory } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import type { ActionInvocation } from "./action-assertions";
import {
  expectActionCalled,
  expectActionNotCalled,
  expectActionOrder,
  expectAnyActionCalled,
} from "./action-assertions";

/** Helper to build a minimal ActionInvocation for testing. */
function inv(
  actionName: string,
  actionStatus: "success" | "failed" = "success",
  opts?: {
    params?: Record<string, unknown>;
    timestamp?: number;
    runId?: string;
  },
): ActionInvocation {
  return {
    actionName,
    actionStatus,
    params: opts?.params,
    result: opts?.params,
    runId: opts?.runId ?? "run-1",
    timestamp: opts?.timestamp ?? Date.now(),
    _raw: { content: { text: "" } } as Memory,
  };
}

describe("action assertion helpers", () => {
  // ── expectActionCalled ──────────────────────────────────────────

  describe("expectActionCalled", () => {
    it("finds an action by exact name", () => {
      const invocations = [inv("CALENDAR_ACTION"), inv("GMAIL_ACTION")];
      const result = expectActionCalled(invocations, "CALENDAR_ACTION");
      expect(result.actionName).toBe("CALENDAR_ACTION");
    });

    it("matches with fuzzy normalization (case + underscores)", () => {
      const invocations = [inv("CALENDAR_ACTION")];
      const result = expectActionCalled(invocations, "calendar_action");
      expect(result.actionName).toBe("CALENDAR_ACTION");

      const result2 = expectActionCalled(invocations, "CalendarAction");
      expect(result2.actionName).toBe("CALENDAR_ACTION");
    });

    it("throws with descriptive error when action not found", () => {
      const invocations = [inv("GMAIL_ACTION"), inv("SEND_MESSAGE")];
      expect(() => expectActionCalled(invocations, "CALENDAR_ACTION")).toThrow(
        /Expected action "CALENDAR_ACTION" to be called/,
      );
      expect(() => expectActionCalled(invocations, "CALENDAR_ACTION")).toThrow(
        /GMAIL_ACTION.*SEND_MESSAGE/,
      );
    });

    it("throws when invocations list is empty", () => {
      expect(() => expectActionCalled([], "ANY_ACTION")).toThrow(/\(none\)/);
    });

    it("validates status when provided", () => {
      const invocations = [inv("MY_ACTION", "failed")];
      expect(() =>
        expectActionCalled(invocations, "MY_ACTION", { status: "success" }),
      ).toThrow();
    });

    it("validates params when provided", () => {
      const invocations = [
        inv("MY_ACTION", "success", {
          params: { query: "test", limit: 10 },
        }),
      ];
      // Partial match should pass
      expectActionCalled(invocations, "MY_ACTION", {
        params: { query: "test" },
      });

      // Mismatched value should fail
      expect(() =>
        expectActionCalled(invocations, "MY_ACTION", {
          params: { query: "wrong" },
        }),
      ).toThrow();
    });

    it("returns the matched invocation", () => {
      const invocations = [
        inv("FIRST_ACTION"),
        inv("TARGET_ACTION", "success", { runId: "special-run" }),
      ];
      const result = expectActionCalled(invocations, "TARGET_ACTION");
      expect(result.runId).toBe("special-run");
    });
  });

  // ── expectActionNotCalled ───────────────────────────────────────

  describe("expectActionNotCalled", () => {
    it("passes when action is absent", () => {
      const invocations = [inv("GMAIL_ACTION")];
      // Should not throw
      expectActionNotCalled(invocations, "CALENDAR_ACTION");
    });

    it("passes on empty invocations", () => {
      expectActionNotCalled([], "ANY_ACTION");
    });

    it("throws when action is present", () => {
      const invocations = [inv("CALENDAR_ACTION", "success")];
      expect(() =>
        expectActionNotCalled(invocations, "CALENDAR_ACTION"),
      ).toThrow(/Expected action "CALENDAR_ACTION" NOT to be called/);
    });

    it("uses fuzzy matching", () => {
      const invocations = [inv("CALENDAR_ACTION")];
      expect(() =>
        expectActionNotCalled(invocations, "calendar_action"),
      ).toThrow();
    });
  });

  // ── expectActionOrder ───────────────────────────────────────────

  describe("expectActionOrder", () => {
    it("passes when actions appear in correct order", () => {
      const invocations = [
        inv("FIRST", "success", { timestamp: 1000 }),
        inv("SECOND", "success", { timestamp: 2000 }),
        inv("THIRD", "success", { timestamp: 3000 }),
      ];
      expectActionOrder(invocations, ["FIRST", "SECOND", "THIRD"]);
    });

    it("passes with non-adjacent actions (allows gaps)", () => {
      const invocations = [
        inv("FIRST", "success", { timestamp: 1000 }),
        inv("UNRELATED", "success", { timestamp: 1500 }),
        inv("SECOND", "success", { timestamp: 2000 }),
      ];
      expectActionOrder(invocations, ["FIRST", "SECOND"]);
    });

    it("throws when order is violated", () => {
      const invocations = [
        inv("SECOND", "success", { timestamp: 1000 }),
        inv("FIRST", "success", { timestamp: 2000 }),
      ];
      expect(() => expectActionOrder(invocations, ["FIRST", "SECOND"])).toThrow(
        /Expected action order violated/,
      );
    });

    it("throws when an action is missing entirely", () => {
      const invocations = [inv("FIRST", "success", { timestamp: 1000 })];
      expect(() =>
        expectActionOrder(invocations, ["FIRST", "MISSING"]),
      ).toThrow(/could not find "MISSING"/);
    });

    it("passes with empty expected list", () => {
      expectActionOrder([inv("ANYTHING")], []);
    });

    it("uses fuzzy matching for order checks", () => {
      const invocations = [
        inv("FIRST_ACTION", "success", { timestamp: 1000 }),
        inv("SECOND_ACTION", "success", { timestamp: 2000 }),
      ];
      expectActionOrder(invocations, ["first_action", "SecondAction"]);
    });
  });

  // ── expectAnyActionCalled ───────────────────────────────────────

  describe("expectAnyActionCalled", () => {
    it("passes when any one candidate is found", () => {
      const invocations = [inv("GMAIL_ACTION")];
      const result = expectAnyActionCalled(invocations, [
        "CALENDAR_ACTION",
        "GMAIL_ACTION",
        "SEND_EMAIL",
      ]);
      expect(result.actionName).toBe("GMAIL_ACTION");
    });

    it("returns the first matching candidate", () => {
      const invocations = [
        inv("SEND_EMAIL", "success", { timestamp: 1000 }),
        inv("GMAIL_ACTION", "success", { timestamp: 2000 }),
      ];
      const result = expectAnyActionCalled(invocations, [
        "SEND_EMAIL",
        "GMAIL_ACTION",
      ]);
      expect(result.actionName).toBe("SEND_EMAIL");
    });

    it("throws when none of the candidates are found", () => {
      const invocations = [inv("UNRELATED_ACTION")];
      expect(() =>
        expectAnyActionCalled(invocations, ["GMAIL_ACTION", "SEND_EMAIL"]),
      ).toThrow(
        /Expected at least one of \[GMAIL_ACTION, SEND_EMAIL\] to be called/,
      );
      expect(() =>
        expectAnyActionCalled(invocations, ["GMAIL_ACTION"]),
      ).toThrow(/UNRELATED_ACTION/);
    });

    it("throws on empty invocations", () => {
      expect(() => expectAnyActionCalled([], ["GMAIL_ACTION"])).toThrow(
        /\(none\)/,
      );
    });

    it("uses fuzzy matching", () => {
      const invocations = [inv("CALENDAR_ACTION")];
      const result = expectAnyActionCalled(invocations, ["calendar_action"]);
      expect(result.actionName).toBe("CALENDAR_ACTION");
    });
  });
});
