/**
 * Integration tests for LifeOps action registration and access gating.
 *
 * Two invariants the agent relies on:
 *
 *   1. LifeOps umbrella actions (MESSAGE, CALENDAR, etc.) are visible to the LLM in any
 *      channel — no `gatePluginSessionForHostedApp` wrapper that hides them
 *      when the LifeOps UI isn't foregrounded. Previously the plugin wrapped
 *      every action's validate() to return false unless an AppManager run or
 *      dashboard overlay heartbeat existed, which meant Discord/Telegram users
 *      could not trigger owner inbox/calendar work at all.
 *
 *   2. RELATIONSHIP is the single registered entry point for the
 *      follow-up surface, and it enforces owner-only access.
 *
 * Uses a real AgentRuntime with PGLite (plugin-sql) — no SQL mocks — so the
 * access helpers (`resolveCanonicalOwnerIdForMessage`, `checkSenderRole`) and
 * the context-signal conversation fetch run their real code paths.
 */

import crypto from "node:crypto";
import type { AgentRuntime, Memory, State, UUID } from "@elizaos/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRealTestRuntime } from "../../../test/helpers/real-runtime";
import { appLifeOpsPlugin } from "../src/plugin.js";

let runtime: AgentRuntime;
let cleanup: () => Promise<void>;

beforeAll(async () => {
  const result = await createRealTestRuntime({
    plugins: [appLifeOpsPlugin],
  });
  runtime = result.runtime;
  cleanup = result.cleanup;
}, 180_000);

afterAll(async () => {
  await cleanup?.();
});

function ownerMessage(text: string): Memory {
  // entityId === agentId → isAgentSelf shortcut → passes every access tier.
  return {
    id: crypto.randomUUID() as UUID,
    entityId: runtime.agentId as UUID,
    roomId: crypto.randomUUID() as UUID,
    agentId: runtime.agentId as UUID,
    content: { text, source: "test" },
  } as Memory;
}

function nonOwnerMessage(text: string): Memory {
  return {
    id: crypto.randomUUID() as UUID,
    entityId: crypto.randomUUID() as UUID,
    roomId: crypto.randomUUID() as UUID,
    agentId: runtime.agentId as UUID,
    content: { text, source: "test" },
  } as Memory;
}

const emptyState: State = { values: {}, data: {}, text: "" };

function findAction(name: string) {
  const action = appLifeOpsPlugin.actions?.find((a) => a.name === name);
  if (!action) {
    throw new Error(
      `${name} not registered in appLifeOpsPlugin.actions — plugin exports changed`,
    );
  }
  return action;
}

describe("LifeOps plugin action gating", () => {
  it("registers MESSAGE so the LLM can see owner inbox/email work without a LifeOps UI session", async () => {
    // The previous `gatePluginSessionForHostedApp` wrapper made every action's
    // validate() return false unless an AppManager run or overlay heartbeat
    // existed for @elizaos/app-lifeops. Neither is set up in this test, so if
    // the wrapper were still in place validate() would return false here.
    const ownerInbox = findAction("MESSAGE");
    const message = ownerMessage(
      "what emails do i have that i need to respond to",
    );

    const result = await ownerInbox.validate(runtime, message, emptyState);

    expect(result).toBe(true);
  });

  it("exposes the full LifeOps action surface on the plugin", () => {
    const actionNames = (appLifeOpsPlugin.actions ?? []).map((a) => a.name);
    // Spot-check a mix of categories: email, calendar, inbox, scheduling, followups.
    for (const expected of [
      "MESSAGE",
      "CALENDAR",
      "LIFE",
      "RELATIONSHIP",
      "MESSAGE",
      "BOOK_TRAVEL",
      "RESOLVE_REQUEST",
    ]) {
      expect(actionNames).toContain(expected);
    }

    for (const removed of [
      "GMAIL_ACTION",
      "INBOX",
      "CALENDAR_ACTION",
      "SCHEDULING",
      "LIST_OVERDUE_FOLLOWUPS",
      "MARK_FOLLOWUP_DONE",
      "SET_FOLLOWUP_THRESHOLD",
      "GENERATE_DOSSIER",
      "COMPUTE_TRAVEL_BUFFER",
      "REGISTER_BROWSER_SESSION",
      "FETCH_BROWSER_ACTIVITY",
      "CHECKIN",
    ]) {
      expect(actionNames).not.toContain(removed);
    }
  });
});

describe.each([
  "RELATIONSHIP",
])("%s owner-only access gate", (actionName) => {
  it("validate() rejects non-owner senders", async () => {
    const action = findAction(actionName);
    const result = await action.validate(
      runtime,
      nonOwnerMessage("follow up with Alice"),
      emptyState,
    );
    expect(result).toBe(false);
  });

  it("validate() accepts the agent itself (agent-self owner shortcut)", async () => {
    const action = findAction(actionName);
    const result = await action.validate(
      runtime,
      ownerMessage("follow up with Alice"),
      emptyState,
    );
    expect(result).toBe(true);
  });
});
