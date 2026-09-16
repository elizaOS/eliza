// @vitest-environment jsdom
/** Exercises strict capability-handoff parsing, session restoration, expiry, and once-only continuation without mocking the boundary under test. */

import type { CapabilityHandoffRequest } from "@elizaos/shared";
import { beforeEach, describe, expect, it } from "vitest";
import type { ChatActionResultSummary, ConversationMessage } from "./api";
import {
  consumePendingCapabilityIntent,
  findCapabilityHandoff,
  markPendingCapabilityReady,
  parseCapabilityHandoff,
  rememberCapabilityHandoff,
  rememberPendingCapabilityHandoff,
  restoreCapabilityHandoffs,
} from "./capability-handoff";

const handoff: CapabilityHandoffRequest = {
  version: 1,
  kind: "capability_handoff",
  capabilityId: "browser-control",
  label: "Browser control",
  availability: "needs_workspace",
  reason: "Browser control needs your personal workspace.",
  currentTier: "shared",
  requiredTier: "personal",
  nextAction: "upgrade_workspace",
  requiresConfirmation: true,
  cta: {
    label: "Set up personal workspace",
    href: "/cloud/agents/agent-1",
  },
  continuation: {
    clientMessageId: "client-1",
    originalIntent: "Book the earliest direct flight.",
  },
};

function actionResult(value: unknown): ChatActionResultSummary {
  return {
    actionName: "UNTRUSTED_NAME",
    success: false,
    values: { capabilityHandoff: value },
  };
}

function message(id: string): ConversationMessage {
  return { id, role: "assistant", text: "Setup needed.", timestamp: 1 };
}

describe("capability handoff boundary", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
  });

  it("accepts a fully validated receipt independent of action name and success", () => {
    expect(findCapabilityHandoff([actionResult(handoff)], "agent-1")).toEqual(
      handoff,
    );
  });

  it.each([
    [
      "external URL",
      { ...handoff, cta: { ...handoff.cta, href: "https://evil.test" } },
    ],
    ["wrong agent", handoff],
    ["wrong tier", { ...handoff, requiredTier: "shared" }],
    ["missing confirmation", { ...handoff, requiresConfirmation: false }],
  ])("rejects %s", (_label, value) => {
    const expectedAgent = _label === "wrong agent" ? "agent-2" : "agent-1";
    expect(parseCapabilityHandoff(value, expectedAgent)).toBeNull();
  });

  it("preserves a long continuation exactly", () => {
    const originalIntent = "x".repeat(16_001);
    expect(
      parseCapabilityHandoff(
        { ...handoff, continuation: { originalIntent } },
        "agent-1",
      )?.continuation?.originalIntent,
    ).toBe(originalIntent);
  });

  it("restores a durable assistant receipt but never attaches it to a user row", () => {
    rememberCapabilityHandoff("assistant-1", handoff);
    rememberCapabilityHandoff("user-1", handoff);
    const restored = restoreCapabilityHandoffs([
      message("assistant-1"),
      { ...message("user-1"), role: "user" },
    ]);
    expect(restored[0].capabilityHandoff).toEqual(handoff);
    expect(restored[1].capabilityHandoff).toBeUndefined();
  });

  it("discards malformed and expired stored receipts", () => {
    window.sessionStorage.setItem(
      "eliza:capability-handoff:message:broken",
      "not json",
    );
    window.sessionStorage.setItem(
      "eliza:capability-handoff:message:expired",
      JSON.stringify({ expiresAt: Date.now() - 1, handoff }),
    );
    expect(
      restoreCapabilityHandoffs([message("broken"), message("expired")]),
    ).toEqual([message("broken"), message("expired")]);
    expect(window.sessionStorage.length).toBe(0);
  });

  it("consumes a matching continuation exactly once and not for another agent", () => {
    rememberPendingCapabilityHandoff(handoff);
    expect(consumePendingCapabilityIntent("agent-2")).toBeNull();
    expect(markPendingCapabilityReady("agent-2")).toBe(false);
    expect(markPendingCapabilityReady("agent-1")).toBe(true);
    expect(consumePendingCapabilityIntent("agent-1")).toBe(
      "Book the earliest direct flight.",
    );
    expect(consumePendingCapabilityIntent("agent-1")).toBeNull();
  });

  it("clears a ready marker when its pending handoff has expired", () => {
    window.sessionStorage.setItem(
      "eliza:capability-handoff:pending",
      JSON.stringify({ expiresAt: Date.now() - 1, handoff }),
    );
    window.sessionStorage.setItem(
      "eliza:capability-handoff:ready-agent",
      "agent-1",
    );

    expect(consumePendingCapabilityIntent("agent-1")).toBeNull();
    expect(
      window.sessionStorage.getItem("eliza:capability-handoff:pending"),
    ).toBeNull();
    expect(
      window.sessionStorage.getItem("eliza:capability-handoff:ready-agent"),
    ).toBeNull();
  });
});
