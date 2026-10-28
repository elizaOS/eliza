import type { Action, ContextObject, Memory } from "@elizaos/core";
import {
  attestAuthenticatedApiDeliveryAudience,
  promoteSubactionsToActions,
} from "@elizaos/core";
import { expect, it } from "vitest";
import { notesAction } from "../../../../plugin-notes/src/action.js";
import { createOwnerReminderDirectRoutingRule } from "../../../../plugin-personal-assistant/src/lifeops/reminders/direct-routing.js";
import { personalAssistantPlugin } from "../../../../plugin-personal-assistant/src/plugin.js";
import { retrieveContextualPlannerActions } from "./action-surface.js";
import {
  collectBudgetedStageOneCandidateActions,
  collectPlannerTools,
} from "./planned-tool.js";
import {
  appendDiscoveredPlannerTools,
  collectDiscoveryCatalogActions,
  createPlannerToolDiscoveryAction,
} from "./tool-discovery.js";

const actions = [
  ...(personalAssistantPlugin.actions ?? []),
  ...promoteSubactionsToActions(notesAction),
];
const rule = createOwnerReminderDirectRoutingRule();
const request =
  "Remind me tomorrow at noon to check the packing list. No alert.";
const intent =
  "Create reminder for tomorrow at noon to check the packing list with no alert.";
function select(
  text = request,
  intents = [intent],
  candidates = ["OWNER_REMINDERS", "TRIGGER"],
  contexts = ["tasks"],
) {
  const selected = collectBudgetedStageOneCandidateActions({
    actions,
    candidateActions: candidates,
    contexts,
    deferUnselectedContexts: true,
    deferParentHints: true,
    intents,
  });
  return retrieveContextualPlannerActions({
    actions,
    selectedActions: selected,
    query: text,
    intents,
    contexts,
    directRouting: { rules: [rule], message: { content: { text } } as Memory },
  }).actions;
}

it("keeps the captured single reminder initial schema on its registered owner", () => {
  expect(select().map((action) => action.name)).toEqual([
    "OWNER_REMINDERS_CREATE",
  ]);
});
it("treats other negative noun-phrase constraints generically without action-name lists", () => {
  expect(
    select("Remind me tomorrow to buy groceries. No sound.", [
      "Create a reminder to buy groceries with no sound.",
    ]).map((action) => action.name),
  ).toEqual(["OWNER_REMINDERS_CREATE"]);
});
it("retains multiple requested operations", () => {
  const selected = select(
    "Remind me tomorrow to pack, and read my notes.",
    ["Create a reminder to pack.", "Read saved notes."],
    ["OWNER_REMINDERS", "NOTES_LIST"],
    ["tasks", "notes"],
  );
  expect(
    selected.some((action) => action.name === "OWNER_REMINDERS_CREATE"),
  ).toBe(true);
  expect(selected.some((action) => action.name === "NOTES_LIST")).toBe(true);
});
it("does not collapse a second positive sentence to the first owner", () => {
  const selected = select(
    "Remind me tomorrow to pack. Delete my old reminders.",
    ["Create a reminder to pack and delete old reminders."],
    ["OWNER_REMINDERS"],
  );
  expect(selected.length).toBeGreaterThan(1);
});
it("keeps unrelated explicit context coverage", () => {
  expect(
    select(request, [intent], ["OWNER_REMINDERS"], ["tasks", "notes"]).length,
  ).toBeGreaterThan(1);
});
it("keeps the conservative fallback without a matching registered owner rule", () => {
  const selected = collectBudgetedStageOneCandidateActions({
    actions,
    candidateActions: ["OWNER_REMINDERS"],
    contexts: ["tasks"],
    deferUnselectedContexts: true,
    deferParentHints: true,
    intents: [intent],
  });
  const result = retrieveContextualPlannerActions({
    actions,
    selectedActions: selected,
    query: request,
    intents: [intent],
    contexts: ["tasks"],
    directRouting: {
      rules: [],
      message: { content: { text: request } } as Memory,
    },
  });
  expect(result.actions.length).toBeGreaterThan(1);
});
it("preserves every authorized tool in discovery and fresh revocation", async () => {
  const message = {
    id: "message",
    agentId: "agent",
    entityId: "owner",
    roomId: "room",
    content: { text: request },
  } as Memory;
  const fixtureRuntime = {
    agentId: "agent",
    getSetting: (key: string) =>
      key === "ELIZA_ADMIN_ENTITY_ID" ? "owner" : undefined,
    getParticipantsForRoom: async () => ["owner", "agent"],
  } as never;
  await attestAuthenticatedApiDeliveryAudience(fixtureRuntime, message, {
    kind: "owner_session",
    principalId: "offline-fixture",
  });
  const authorized = collectDiscoveryCatalogActions({
    actions,
    message,
    selectedContexts: ["tasks"],
    userRoles: ["OWNER"],
  });
  expect(authorized.map((action) => action.name)).toEqual(
    expect.arrayContaining([
      "OWNER_REMINDERS_CREATE",
      "CALENDAR_CREATE_EVENT",
      "NOTES_LIST",
    ]),
  );
  const unavailable = collectDiscoveryCatalogActions({
    actions,
    message,
    selectedContexts: ["tasks"],
    userRoles: ["USER"],
  });
  expect(
    unavailable.some((action) => action.name === "OWNER_REMINDERS_CREATE"),
  ).toBe(false);
  const unattested = collectDiscoveryCatalogActions({
    actions,
    message: JSON.parse(JSON.stringify(message)),
    selectedContexts: ["tasks"],
    userRoles: ["OWNER"],
  });
  expect(
    unattested.some((action) => action.name === "OWNER_REMINDERS_CREATE"),
  ).toBe(false);
  const loaded: Action[] = [];
  let fresh = authorized;
  const discovery = createPlannerToolDiscoveryAction(
    authorized,
    (found) => loaded.push(...found),
    async () => fresh,
  );
  const runtime = { actions } as never;
  for (const action of authorized) {
    const result = await discovery.handler(runtime, message, undefined, {
      parameters: { names: [action.name] },
    });
    expect(result && typeof result === "object" && result.success).toBe(true);
    expect(loaded.some((candidate) => candidate.name === action.name)).toBe(
      true,
    );
  }
  const revoked = authorized[0];
  if (!revoked) throw new Error("Missing authorized fixture action");
  fresh = authorized.filter((action) => action.name !== revoked.name);
  loaded.length = 0;
  const rejected = await discovery.handler(runtime, message, undefined, {
    parameters: { names: [revoked.name] },
  });
  expect(rejected && typeof rejected === "object" && rejected.success).toBe(
    false,
  );
  expect(loaded).toEqual([]);
});
it("retains dynamically loaded schemas across later loads without executing domain actions", async () => {
  const message = { content: { text: request } } as Memory;
  const exposed = select();
  const context = {
    events: [
      { id: "test", type: "tool", tool: { name: "OWNER_REMINDERS_CREATE" } },
    ],
  } as unknown as ContextObject;
  const tools = collectPlannerTools(context, exposed, {
    canonicalFamilies: true,
    directActionNames: new Set(exposed.map((action) => action.name)),
  });
  const discovery = createPlannerToolDiscoveryAction(
    actions,
    (found, names) =>
      appendDiscoveredPlannerTools(context, tools, found, names),
    async () => actions,
  );
  const first = actions.find((action) => action.name === "NOTES_LIST");
  const second = actions.find(
    (action) => action.name === "CALENDAR_CREATE_EVENT",
  );
  if (!first || !second) throw new Error("Missing real registry fixtures");
  await discovery.handler({ actions } as never, message, undefined, {
    parameters: { names: [first.name] },
  });
  await discovery.handler({ actions } as never, message, undefined, {
    parameters: { names: [second.name] },
  });
  expect(tools.map((tool) => tool.name)).toEqual(
    expect.arrayContaining(["OWNER_REMINDERS_CREATE", first.name, second.name]),
  );
});

it.each([
  "No longer remind me",
  "No delete the old one",
  "No delete",
  "No cancel",
])(
  "preserves the fallback for an ambiguous negative operation: %s",
  (clause) => {
    const text = `Remind me tomorrow at noon to check the packing list. ${clause}.`;
    expect(select(text, [text]).length).toBeGreaterThan(1);
  },
);
