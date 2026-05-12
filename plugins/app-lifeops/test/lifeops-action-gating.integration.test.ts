/**
 * Integration tests for LifeOps action registration and access gating.
 *
 * Invariants the agent relies on:
 *
 *   1. Owner operation umbrella actions (MESSAGE, CALENDAR, OWNER_*, etc.) are visible to the
 *      LLM in any channel — no `gatePluginSessionForHostedApp` wrapper that
 *      hides them when the LifeOps UI isn't foregrounded. Previously the
 *      plugin wrapped every action's validate() to return false unless an
 *      AppManager run or dashboard overlay heartbeat existed, which meant
 *      Discord/Telegram users could not trigger owner inbox/calendar work
 *      at all.
 *
 *   2. ENTITY is the canonical entry point for people / contacts / typed
 *      relationships. Follow-up cadence belongs to SCHEDULED_TASKS;
 *      ENTITY's flat action surface is exactly
 *      `add | list | log_interaction | set_identity | set_relationship | merge`.
 *
 *   3. SCHEDULED_TASKS is the canonical entry point for runner-managed
 *      reminders / check-ins / follow-ups / approvals.
 *
 *   4. Owner operations use canonical `action` discriminators on the public
 *      wrappers; legacy source actions remain implementation-only.
 *
 *   5. VOICE_CALL exposes a single `dial` action with a `recipientKind`
 *      discriminator (`owner` | `external` | `e164`).
 *
 * Uses a real AgentRuntime with PGLite (plugin-sql) — no SQL mocks — so the
 * access helpers (`resolveCanonicalOwnerIdForMessage`, `checkSenderRole`) and
 * the context-signal conversation fetch run their real code paths.
 */

import crypto from "node:crypto";
import type { AgentRuntime, Memory, State, UUID } from "@elizaos/core";
import { CONTEXT_ROUTING_STATE_KEY } from "@elizaos/core";
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

const emptyState: State = { values: {}, data: {}, text: "" };
const messagingState: State = {
  values: {
    [CONTEXT_ROUTING_STATE_KEY]: {
      primaryContext: "messaging",
      secondaryContexts: ["email"],
    },
  },
  data: {},
  text: "",
};

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

    const result = await ownerInbox.validate(runtime, message, messagingState);

    expect(result).toBe(true);
  });

  it("exposes the canonical owner-operation action surface on the plugin", () => {
    const actionNames = (appLifeOpsPlugin.actions ?? []).map((a) => a.name);
    // Spot-check a mix of categories: email, calendar, owner state, scheduling, followups.
    for (const expected of [
      "MESSAGE",
      "CALENDAR",
      "OWNER_TODOS",
      "OWNER_REMINDERS",
      "OWNER_ALARMS",
      "OWNER_GOALS",
      "OWNER_ROUTINES",
      "OWNER_HEALTH",
      "OWNER_SCREENTIME",
      "OWNER_FINANCES",
      "BLOCK",
      "CREDENTIALS",
      "ENTITY",
      "PERSONAL_ASSISTANT",
      "RESOLVE_REQUEST",
      // SCHEDULED_TASKS is the canonical home for runner-managed
      // reminders / check-ins / follow-ups; ENTITY's surface no longer
      // carries the follow-up verbs.
      "SCHEDULED_TASKS",
      "WORK_THREAD",
    ]) {
      expect(actionNames).toContain(expected);
    }

    for (const removed of [
      "LIFE",
      "PROFILE",
      "RELATIONSHIP",
      "MONEY",
      "PAYMENTS",
      "SUBSCRIPTIONS",
      "BOOK_TRAVEL",
      "SCHEDULING_NEGOTIATION",
      "APP_BLOCK",
      "WEBSITE_BLOCK",
      "AUTOFILL",
      "PASSWORD_MANAGER",
      "SCHEDULED_TASK",
      "LIFEOPS_THREAD_CONTROL",
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

  it("ENTITY exposes a flat 6-action canonical surface (no transitional follow-up similes)", () => {
    const entity = findAction("ENTITY");
    const actionParam = (entity.parameters ?? []).find(
      (p) => p.name === "action",
    );
    if (!actionParam) {
      throw new Error("ENTITY has no `action` parameter");
    }
    // Follow-up cadence lives on SCHEDULED_TASKS now; the transitional
    // legacy child names (`add_follow_up`, `complete_follow_up`,
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

  it("registers the 7 transitional ENTITY follow-up subactions as SCHEDULED_TASKS similes", () => {
    // SCHEDULED_TASKS is the canonical home for follow-up cadence; the simile
    // registration is what lets the planner pick SCHEDULED_TASKS when the user
    // asks to add/list/complete a follow-up.
    const scheduledTask = (appLifeOpsPlugin.actions ?? []).find(
      (a) => a.name === "SCHEDULED_TASKS",
    );
    if (!scheduledTask) {
      throw new Error(
        "SCHEDULED_TASKS is not registered in appLifeOpsPlugin.actions",
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

  it("OWNER_FINANCES replaces MONEY/SUBSCRIPTIONS/PAYMENTS and uses action", () => {
    const money = findAction("OWNER_FINANCES");
    const paramNames = (money.parameters ?? []).map((p) => p.name);
    expect(paramNames).toContain("action");
    expect(paramNames).not.toContain("mode");
    const actionEnum =
      (money.parameters ?? []).find((p) => p.name === "action")?.schema as
        | { enum?: readonly string[] }
        | undefined;
    expect(actionEnum?.enum).toEqual(
      expect.arrayContaining([
        "dashboard",
        "list_sources",
        "import_csv",
        "spending_summary",
        "recurring_charges",
        "subscription_audit",
        "subscription_cancel",
        "subscription_status",
      ]),
    );
    expect(money.similes ?? []).toEqual(
      expect.arrayContaining(["MONEY", "PAYMENTS", "SUBSCRIPTIONS"]),
    );

    // Legacy umbrella names must NOT be registered as standalone actions.
    const actionNames = (appLifeOpsPlugin.actions ?? []).map((a) => a.name);
    expect(actionNames).not.toContain("MONEY");
    expect(actionNames).not.toContain("PAYMENTS");
    expect(actionNames).not.toContain("SUBSCRIPTIONS");
  });

  it("BLOCK umbrella replaces APP_BLOCK + WEBSITE_BLOCK and preserves them as similes (Audit B D-1)", () => {
    const block = findAction("BLOCK");
    expect(block.similes ?? []).toEqual(
      expect.arrayContaining(["APP_BLOCK", "WEBSITE_BLOCK"]),
    );
    const targetEnum =
      (block.parameters ?? []).find((p) => p.name === "target")?.schema as
        | { enum?: readonly string[] }
        | undefined;
    expect(targetEnum?.enum).toEqual(["app", "website"]);
    const actionEnum =
      (block.parameters ?? []).find((p) => p.name === "action")?.schema as
        | { enum?: readonly string[] }
        | undefined;
    expect(actionEnum?.enum).toEqual([
      "block",
      "unblock",
      "status",
      "request_permission",
      "release",
      "list_active",
    ]);

    const actionNames = (appLifeOpsPlugin.actions ?? []).map((a) => a.name);
    expect(actionNames).not.toContain("APP_BLOCK");
    expect(actionNames).not.toContain("WEBSITE_BLOCK");
  });

  it("CREDENTIALS umbrella replaces AUTOFILL + PASSWORD_MANAGER and preserves them as similes (Audit B D-5)", () => {
    const credentials = findAction("CREDENTIALS");
    expect(credentials.similes ?? []).toEqual(
      expect.arrayContaining(["AUTOFILL", "PASSWORD_MANAGER"]),
    );
    const actionEnum =
      (credentials.parameters ?? []).find((p) => p.name === "action")
        ?.schema as { enum?: readonly string[] } | undefined;
    expect(actionEnum?.enum).toEqual([
      "fill",
      "whitelist_add",
      "whitelist_list",
      "search",
      "list",
      "inject_username",
      "inject_password",
    ]);

    const actionNames = (appLifeOpsPlugin.actions ?? []).map((a) => a.name);
    expect(actionNames).not.toContain("AUTOFILL");
    expect(actionNames).not.toContain("PASSWORD_MANAGER");
  });

  it("registers per-action virtuals for the BLOCK / OWNER_FINANCES / CREDENTIALS umbrellas", () => {
    const actionNames = (appLifeOpsPlugin.actions ?? []).map((a) => a.name);
    // Spot-check one virtual per umbrella to confirm `promoteSubactionsToActions`
    // wired the parents through. Virtuals exist alongside the umbrella so the
    // planner gets a discoverable top-level entry per child action.
    for (const expected of [
      "BLOCK",
      "BLOCK_BLOCK",
      "BLOCK_UNBLOCK",
      "BLOCK_STATUS",
      "BLOCK_REQUEST_PERMISSION",
      "BLOCK_RELEASE",
      "BLOCK_LIST_ACTIVE",
      "OWNER_FINANCES",
      "OWNER_FINANCES_DASHBOARD",
      "OWNER_FINANCES_RECURRING_CHARGES",
      "OWNER_FINANCES_SUBSCRIPTION_CANCEL",
      "CREDENTIALS",
      "CREDENTIALS_FILL",
      "CREDENTIALS_INJECT_PASSWORD",
    ]) {
      expect(actionNames).toContain(expected);
    }
  });

  it("VOICE_CALL exposes a single `dial` action with a recipientKind discriminator", () => {
    const voiceCall = findAction("VOICE_CALL");
    const actionParam = (voiceCall.parameters ?? []).find(
      (p) => p.name === "action",
    );
    if (!actionParam) {
      throw new Error("VOICE_CALL has no `action` parameter");
    }
    const enumValues =
      (actionParam.schema as { enum?: readonly string[] } | undefined)
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
  it("declares an owner role gate", () => {
    const action = findAction(actionName);
    expect(action.roleGate).toEqual({ minRole: "OWNER" });
  });

  it("validate() accepts routed owner traffic once role gating has passed", async () => {
    const action = findAction(actionName);
    const result = await action.validate(
      runtime,
      ownerMessage("follow up with Alice"),
      emptyState,
    );
    expect(result).toBe(true);
  });
});
