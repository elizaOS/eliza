/**
 * Integration tests for LifeOps action registration and access gating.
 *
 * Invariants the agent relies on:
 *
 *   1. LifeOps umbrella actions (MESSAGE, CALENDAR, etc.) are visible to the
 *      LLM in any channel — no `gatePluginSessionForHostedApp` wrapper that
 *      hides them when the LifeOps UI isn't foregrounded. Previously the
 *      plugin wrapped every action's validate() to return false unless an
 *      AppManager run or dashboard overlay heartbeat existed, which meant
 *      Discord/Telegram users could not trigger owner inbox/calendar work
 *      at all.
 *
 *   2. ENTITY is the canonical entry point for people / contacts / typed
 *      relationships. The legacy `RELATIONSHIP` name is a one-release simile
 *      so cached planner outputs keep resolving.
 *
 *   3. SCHEDULED_TASK is the canonical entry point for runner-managed
 *      reminders / check-ins / follow-ups / approvals (W3-C drift D-2). The
 *      transitional ENTITY follow-up verbs collapse onto its simile list.
 *
 *   4. LIFE.policy_* owns owner-policy writes (W3-C drift D-3). PROFILE
 *      keeps the legacy simile names registered for one release.
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
      "ENTITY",
      "MESSAGE",
      "BOOK_TRAVEL",
      "RESOLVE_REQUEST",
      // W3-C drift D-2: the SCHEDULED_TASK umbrella is the canonical home
      // for the runner's verbs; ENTITY's transitional follow-up subactions
      // collapse onto it.
      "SCHEDULED_TASK",
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
      // Wave-2 W2-A: RELATIONSHIP umbrella renamed to ENTITY; old name
      // remains a simile so the planner does not regress.
      "RELATIONSHIP",
    ]) {
      expect(actionNames).not.toContain(removed);
    }
  });

  it("registers the 7 transitional ENTITY follow-up subactions as SCHEDULED_TASK similes", () => {
    // W3-C drift D-2: the follow-up verbs collapse onto SCHEDULED_TASK; the
    // simile registration is what lets the planner pick SCHEDULED_TASK when
    // the user asks to add/list/complete a follow-up. ENTITY still keeps the
    // simile names registered for one release as a planner-cache alias.
    const scheduledTask = (appLifeOpsPlugin.actions ?? []).find(
      (a) => a.name === "SCHEDULED_TASK",
    );
    if (!scheduledTask) {
      throw new Error(
        "SCHEDULED_TASK is not registered in appLifeOpsPlugin.actions",
      );
    }
    for (const transitional of [
      "ADD_FOLLOW_UP",
      "COMPLETE_FOLLOW_UP",
      "FOLLOW_UP_LIST",
      "DAYS_SINCE",
      "LIST_OVERDUE_FOLLOWUPS",
      "MARK_FOLLOWUP_DONE",
      "SET_FOLLOWUP_THRESHOLD",
    ]) {
      expect(scheduledTask.similes ?? []).toContain(transitional);
    }
  });

  it("LIFE owns the canonical policy.* subactions (W3-C drift D-3)", () => {
    // W3-C drift D-3: LIFE.policy_set_reminder + LIFE.policy_configure_escalation
    // are the canonical homes for owner-policy writes; PROFILE keeps the legacy
    // simile names registered for one release as a planner-cache alias.
    const life = (appLifeOpsPlugin.actions ?? []).find((a) => a.name === "LIFE");
    if (!life) throw new Error("LIFE is not registered in appLifeOpsPlugin.actions");
    const subactionParam = (life.parameters ?? []).find(
      (p) => p.name === "subaction",
    );
    if (!subactionParam) throw new Error("LIFE has no `subaction` parameter");
    const enumValues =
      (subactionParam.schema as { enum?: readonly string[] } | undefined)?.enum ?? [];
    expect(enumValues).toContain("policy_set_reminder");
    expect(enumValues).toContain("policy_configure_escalation");
    expect(life.similes ?? []).toContain("SET_REMINDER_INTENSITY");
    expect(life.similes ?? []).toContain("CONFIGURE_ESCALATION");
  });

  it("SUBSCRIPTIONS + PAYMENTS use canonical `subaction` parameter (W3-C drift D-5)", () => {
    // W3-C drift D-5: rename `mode` → `subaction`; legacy `mode` stays as a
    // one-release alias param so cached planner outputs keep resolving.
    for (const name of ["SUBSCRIPTIONS", "PAYMENTS"]) {
      const action = (appLifeOpsPlugin.actions ?? []).find((a) => a.name === name);
      if (!action) throw new Error(`${name} is not registered in appLifeOpsPlugin.actions`);
      const paramNames = (action.parameters ?? []).map((p) => p.name);
      expect(paramNames).toContain("subaction");
      expect(paramNames).toContain("mode");
    }
  });
});

describe.each([
  "ENTITY",
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
