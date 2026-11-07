import {
  AgentRuntime,
  attestAuthenticatedApiDeliveryAudience,
  ContextRegistry,
  type Memory,
  promoteSubactionsToActions,
  runResponseHandlerEvaluators,
} from "@elizaos/core";
import { expect, it, vi } from "vitest";
import { triggerAction } from "../../../../../packages/agent/src/actions/trigger.ts";
import { ownerRemindersAction } from "../../../../plugin-personal-assistant/src/actions/owner-surfaces.ts";
import { ownerPrivateAction } from "../../../../plugin-personal-assistant/src/lifeops/access.ts";
import {
  createOwnerReminderDirectRoutingRule,
  createOwnerReminderReadRoutingRule,
  registerOwnerReminderDirectRouting,
} from "../../../../plugin-personal-assistant/src/lifeops/reminders/direct-routing.ts";
import { DEFAULT_CONTEXT_DEFINITIONS } from "../../runtime/default-contexts.ts";
import {
  collectV5PlannerCandidateActions,
  retrieveContextualPlannerActions,
} from "./action-surface.ts";
import {
  collectBudgetedStageOneCandidateActions,
  collectPlannerTools,
} from "./planned-tool.ts";
import { BUILTIN_RESPONSE_HANDLER_EVALUATORS } from "./stage1-evaluators.ts";
import { collectDiscoveryCatalogActions } from "./tool-discovery.ts";

const owner = "11111111-1111-4111-8111-111111111111",
  agent = "22222222-2222-4222-8222-222222222222",
  room = "33333333-3333-4333-8333-333333333333";
const text = "What reminders do I have?",
  intent = "List the user's current reminders";
const readRule = createOwnerReminderReadRoutingRule();
async function replay({
  request = text,
  intents = [intent],
  candidates = [],
  register = true,
  noOwner = false,
  revoked = false,
  group = false,
  role = "OWNER",
}: {
  request?: string;
  intents?: string[];
  candidates?: string[];
  register?: boolean;
  noOwner?: boolean;
  revoked?: boolean;
  group?: boolean;
  role?: "OWNER" | "USER";
} = {}) {
  const runtime = new AgentRuntime({
    agentId: agent,
    character: {
      name: "Owner read surface",
      bio: [],
      settings: { ELIZA_ADMIN_ENTITY_ID: owner },
    },
    logLevel: "fatal",
  });
  runtime.contexts = new ContextRegistry([...DEFAULT_CONTEXT_DEFINITIONS]);
  vi.spyOn(runtime, "getRoom").mockResolvedValue(undefined);
  vi.spyOn(runtime, "getParticipantsForRoom").mockResolvedValue([owner, agent]);
  const ownerFamily = promoteSubactionsToActions(
    ownerPrivateAction(ownerRemindersAction),
  );
  runtime.actions = [
    ...(noOwner
      ? []
      : ownerFamily.map((action) =>
          revoked && action.name === "OWNER_REMINDERS_REVIEW"
            ? { ...action, validate: async () => false }
            : action,
        )),
    ...promoteSubactionsToActions(triggerAction),
  ];
  if (register) registerOwnerReminderDirectRouting(runtime);
  const message = {
    id: "44444444-4444-4444-8444-444444444444",
    agentId: agent,
    entityId: owner,
    roomId: room,
    content: {
      text: request,
      source: "client_chat",
      channelType: group ? "GROUP" : "DM",
    },
  } as Memory;
  await attestAuthenticatedApiDeliveryAudience(runtime, message, {
    kind: "owner_session",
    principalId: "offline-fixture",
  });
  const state = { text: "", values: {}, data: {} };
  const messageHandler = {
    processMessage: "RESPOND",
    plan: {
      contexts: ["tasks"],
      intents: [...intents],
      candidateActions: [...candidates],
      parentActionHints: [],
      requiresTool: true,
      replyEffectStatus: "pending",
    },
  };
  const evaluator = BUILTIN_RESPONSE_HANDLER_EVALUATORS.find(
    (e) => e.name === "core.direct_registered_capability_request",
  );
  if (!evaluator) throw new Error("Expected direct capability evaluator");
  await runResponseHandlerEvaluators({
    runtime,
    message,
    state,
    messageHandler,
    availableContexts: DEFAULT_CONTEXT_DEFINITIONS,
    userRoles: [role],
    evaluators: [evaluator],
  } as never);
  const admitted = await collectV5PlannerCandidateActions({
    runtime,
    message,
    state,
    selectedContexts: messageHandler.plan.contexts,
    candidateActions: messageHandler.plan.candidateActions,
    intents: messageHandler.plan.intents,
    userRoles: [role],
  });
  const selected = collectBudgetedStageOneCandidateActions({
    actions: admitted,
    candidateActions: messageHandler.plan.candidateActions,
    contexts: messageHandler.plan.contexts,
    deferUnselectedContexts: true,
    deferParentHints: true,
    intents: messageHandler.plan.intents,
  });
  const initial = retrieveContextualPlannerActions({
    actions: admitted,
    selectedActions: selected,
    query: request,
    intents: messageHandler.plan.intents,
    contexts: messageHandler.plan.contexts,
    directRouting: { rules: register ? [readRule] : [], message },
  }).actions;
  const tools = collectPlannerTools(
    {
      events: [{ id: "surface", type: "tool", tool: { name: "VIEWS" } }],
    } as never,
    initial,
    {
      canonicalFamilies: true,
      directActionNames: new Set(selected.map((a) => a.name)),
    },
  );
  const catalog = collectDiscoveryCatalogActions({
    actions: runtime.actions,
    message,
    selectedContexts: ["tasks"],
    userRoles: [role],
  });
  return { runtime, messageHandler, admitted, initial, tools, catalog };
}
it.each([
  { candidates: [] },
  { candidates: ["TRIGGER_LIST"] },
  { candidates: ["OWNER_REMINDERS"] },
])(
  "routes the known tasks/list intent through admitted canonical review (hints=$candidates)",
  async ({ candidates }) => {
    const before = await replay({ candidates, register: false }),
      after = await replay({ candidates });
    expect(after.messageHandler.plan.candidateActions).toContain(
      "OWNER_REMINDERS_REVIEW",
    );
    expect(after.tools.map((t) => t.name)).toContain("OWNER_REMINDERS_REVIEW");
    expect(after.tools.map((t) => t.name)).not.toContain("TRIGGER_LIST");
    expect(after.tools.map((t) => t.name)).not.toContain("TRIGGER");
    expect(after.tools.map((t) => t.name)).not.toContain(
      "OWNER_REMINDERS_CREATE",
    );
    expect(after.admitted.some((a) => a.name === "TRIGGER_LIST")).toBe(false);
    expect(after.catalog.map((a) => a.name)).toEqual(
      expect.arrayContaining([
        "OWNER_REMINDERS_REVIEW",
        "OWNER_REMINDERS_CREATE",
        "TRIGGER_LIST",
        "TRIGGER_CREATE",
      ]),
    );
    const review = after.tools.find((t) => t.name === "OWNER_REMINDERS_REVIEW");
    const reviewAction = after.runtime.actions.find(
      (a) => a.name === "OWNER_REMINDERS_REVIEW",
    );
    if (!reviewAction) throw new Error("Expected reminders review action");
    const baselineReview = collectPlannerTools(
      {
        events: [{ type: "tool", tool: { name: "OWNER_REMINDERS" } }],
      } as never,
      [reviewAction],
      {
        canonicalFamilies: true,
        directActionNames: new Set(["OWNER_REMINDERS_REVIEW"]),
      },
    ).find((t) => t.name === "OWNER_REMINDERS_REVIEW");
    expect(review).toEqual(baselineReview);
    expect(before.tools.map((tool) => tool.name)).toContain("TRIGGER_LIST");
    expect(
      before.admitted.some(
        (action) => action.name === "OWNER_REMINDERS_REVIEW",
      ),
    ).toBe(true);
  },
);
it.each([
  "List my reminders.",
  "Please show me my saved reminders!",
  "What reminders do I have?",
  "Which are my reminders?",
  "Do I have any reminders?",
])("declares complete read grammar: %s", (request) => {
  expect(readRule.matches(request)).toBe(true);
  expect(createOwnerReminderDirectRoutingRule().matches(request)).toBe(false);
});
it.each([
  "What reminders do I have and list my automations?",
  "List my reminders then create one",
  "List Sam's reminders",
  "Do not list my reminders",
  "If I ask list my reminders, what happens?",
  'Quote "list my reminders"',
  "Remind me tomorrow to pack",
  "Delete my reminders",
  "Show reminders in Google",
  "List reminders about my taxes",
])("retains fallback for other work: %s", (request) =>
  expect(readRule.matches(request)).toBe(false),
);
it.each([
  { noOwner: true },
  { revoked: true },
  { group: true },
  { role: "USER" as const },
])(
  "does not replace fallback without current owner authority: %j",
  async (options) => {
    const result = await replay({ ...options, candidates: ["TRIGGER_LIST"] });
    expect(result.messageHandler.plan.candidateActions).not.toContain(
      "OWNER_REMINDERS_REVIEW",
    );
    if (options.role !== "USER")
      expect(result.admitted.map((a) => a.name)).toContain("TRIGGER_LIST");
  },
);
it("preserves the generic automation operation for a compound reminder and automation read", async () => {
  const result = await replay({
    request: "List my reminders and list my automations",
    intents: ["List saved reminders", "List raw automations"],
    candidates: ["OWNER_REMINDERS_REVIEW", "TRIGGER_LIST"],
  });
  expect(result.admitted.map((a) => a.name)).toEqual(
    expect.arrayContaining(["OWNER_REMINDERS_REVIEW", "TRIGGER_LIST"]),
  );
});

it("matches an attributed typed intent without treating a human third-party ask as owner inventory", () => {
  expect(readRule.matches(intent)).toBe(true);
  expect(
    readRule.matches(intent, {
      content: { channelType: "DM", text: intent },
    } as Memory),
  ).toBe(false);
});
