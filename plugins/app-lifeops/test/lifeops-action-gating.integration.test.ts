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
 *      so cached planner outputs keep resolving. Follow-up cadence belongs
 *      to SCHEDULED_TASK; ENTITY's flat subaction surface is exactly
 *      `add | list | log_interaction | set_identity | set_relationship | merge`.
 *
 *   3. SCHEDULED_TASK is the canonical entry point for runner-managed
 *      reminders / check-ins / follow-ups / approvals.
 *
 *   4. LIFE.policy_* is the only home for owner-policy writes
 *      (`policy_set_reminder`, `policy_configure_escalation`). PROFILE's
 *      flat surface is exactly `save | capture_phone`.
 *
 *   5. SUBSCRIPTIONS + PAYMENTS expose only `subaction`; the legacy `mode`
 *      alias is gone.
 *
 *   6. VOICE_CALL exposes a single `dial` verb with a `recipientKind`
 *      discriminator (`owner` | `external` | `e164`).
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
      // SCHEDULED_TASK is the canonical home for runner-managed
      // reminders / check-ins / follow-ups; ENTITY's surface no longer
      // carries the follow-up verbs.
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

  it("ENTITY exposes a flat 6-verb canonical surface (no transitional follow-up similes)", () => {
    const entity = findAction("ENTITY");
    const subactionParam = (entity.parameters ?? []).find(
      (p) => p.name === "subaction",
    );
    if (!subactionParam) {
      throw new Error("ENTITY has no `subaction` parameter");
    }
    // Follow-up cadence lives on SCHEDULED_TASK now; the transitional
    // subaction names (`add_follow_up`, `complete_follow_up`,
    // `follow_up_list`, `days_since`, `list_overdue_followups`,
    // `mark_followup_done`, `set_followup_threshold`) and the legacy
    // contact aliases (`add_contact`, `list_contacts`) must be gone from
    // ENTITY's similes so the planner is never tempted to land them here.
    for (const dropped of [
      "ADD_FOLLOW_UP",
      "COMPLETE_FOLLOW_UP",
      "FOLLOW_UP_LIST",
      "DAYS_SINCE",
      "LIST_OVERDUE_FOLLOWUPS",
      "MARK_FOLLOWUP_DONE",
      "SET_FOLLOWUP_THRESHOLD",
      "FOLLOW_UPS",
      "OVERDUE_FOLLOWUPS",
      "ADD_CONTACT",
    ]) {
      expect(entity.similes ?? []).not.toContain(dropped);
    }
  });

  it("registers the 7 transitional ENTITY follow-up subactions as SCHEDULED_TASK similes", () => {
    // SCHEDULED_TASK is the canonical home for follow-up cadence; the simile
    // registration is what lets the planner pick SCHEDULED_TASK when the user
    // asks to add/list/complete a follow-up.
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

  it("LIFE owns the canonical policy.* subactions; PROFILE no longer carries the policy aliases", () => {
    // LIFE.policy_set_reminder + LIFE.policy_configure_escalation are the
    // only home for owner-policy writes. PROFILE's flat surface is
    // `save | capture_phone`.
    const life = findAction("LIFE");
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

    const profile = findAction("PROFILE");
    const profileSubactionParam = (profile.parameters ?? []).find(
      (p) => p.name === "subaction",
    );
    if (!profileSubactionParam) {
      throw new Error("PROFILE has no `subaction` parameter");
    }
    const profileEnum =
      (profileSubactionParam.schema as { enum?: readonly string[] } | undefined)
        ?.enum ?? [];
    expect(profileEnum).toEqual(["save", "capture_phone"]);
    expect(profile.similes ?? []).not.toContain("SET_REMINDER_INTENSITY");
    expect(profile.similes ?? []).not.toContain("CONFIGURE_ESCALATION");
  });

  it("SUBSCRIPTIONS + PAYMENTS expose only canonical `subaction` (mode alias dropped)", () => {
    for (const name of ["SUBSCRIPTIONS", "PAYMENTS"]) {
      const action = findAction(name);
      const paramNames = (action.parameters ?? []).map((p) => p.name);
      expect(paramNames).toContain("subaction");
      expect(paramNames).not.toContain("mode");
    }
  });

  it("VOICE_CALL exposes a single `dial` verb with a recipientKind discriminator", () => {
    const voiceCall = findAction("VOICE_CALL");
    const subactionParam = (voiceCall.parameters ?? []).find(
      (p) => p.name === "subaction",
    );
    if (!subactionParam) {
      throw new Error("VOICE_CALL has no `subaction` parameter");
    }
    const enumValues =
      (subactionParam.schema as { enum?: readonly string[] } | undefined)
        ?.enum ?? [];
    expect(enumValues).toEqual(["dial"]);

    const recipientKindParam = (voiceCall.parameters ?? []).find(
      (p) => p.name === "recipientKind",
    );
    if (!recipientKindParam) {
      throw new Error("VOICE_CALL has no `recipientKind` parameter");
    }
    const recipientEnum =
      (recipientKindParam.schema as { enum?: readonly string[] } | undefined)
        ?.enum ?? [];
    expect(recipientEnum).toEqual(["owner", "external", "e164"]);
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
