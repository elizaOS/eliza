import type { MessageAdapter, MessageRef, MessageSource } from "@elizaos/core";
import type {
  ScenarioCheckResult,
  ScenarioContext,
} from "@elizaos/scenario-runner/schema";
import { scenario } from "@elizaos/scenario-runner/schema";

/**
 * Behavior scenario for the cross-channel INBOX routing surface that fronts
 * the `inbox_triage` LifeOps capability.
 *
 * Routing reality (verified against the promoted-action registry):
 * `@elizaos/plugin-personal-assistant` registers the INBOX umbrella via
 * `promoteSubactionsToActions(inboxAction)`, so the planner sees the umbrella
 * `INBOX` plus per-subaction virtuals `INBOX_LIST` / `INBOX_SEARCH` /
 * `INBOX_SUMMARIZE` / `INBOX_TRIAGE` / ... . Each virtual injects the
 * discriminator (`"action":"list"` etc.) into the dispatched parameters, so
 * the planner-trace assertions below match either routing shape: the promoted
 * virtual name OR the umbrella with a structured `action` parameter.
 *
 * The `triage` subaction is the capability entrypoint (#11383): it fetches
 * fresh cross-channel messages through the same fan-out `list` uses, runs the
 * REAL LLM triage classifier over the ones without a persisted entry
 * (`InboxService.triage` -> `classifyMessages`, model calls tagged
 * `purpose: "inbox_triage"` — the optimized-prompt consumer that
 * `resolveOptimizedPromptForRuntime(..., "inbox_triage", ...)` feeds), and
 * persists one `app_inbox.life_inbox_triage_entries` row per message. A live
 * "triage my inbox" request therefore reaches the capability prompt through
 * the planner — no HTTP route or custom seed shim required.
 *
 * The seed registers scenario-scoped message adapters (Discord / Gmail /
 * Telegram) on the core triage service so the INBOX fan-out has real inbound
 * content to classify: a production-outage DM, an automated newsletter, and a
 * scheduling question. The adapters answer only this scenario's runtime
 * (matched by agentId), so the global registry cannot bleed into sibling
 * scenarios that share the process.
 *
 * Load-bearing checks:
 *   1. planner-trace assertions prove each intent routes to the right INBOX
 *      subaction (list / summarize / search / triage) and not MESSAGE or
 *      CALENDAR;
 *   2. a `modelCallOccurred` finalCheck fails the scenario when no trajectory
 *      model call carries `purpose: "inbox_triage"` — the capability prompt
 *      must actually fire under the live model;
 *   3. a custom finalCheck reads the persisted triage entries back through
 *      `InboxRepository` and asserts the organic planner-driven run persisted
 *      one entry per seeded message, with the outage classified as an act-now
 *      item.
 *
 * Classification *quality* (urgent vs noise vs needs_reply, per message) is
 * graded by the sibling `inbox-triage-classification-outcome` scenario; this
 * scenario is the organic planner-path regression.
 */

// Stable source-message ids so the seed adapters and the finalCheck readback
// agree.
const OUTAGE_MSG_ID = "scenario-inbox-cap-urgent-outage";
const NOISE_MSG_ID = "scenario-inbox-cap-noise-newsletter";
const QUESTION_MSG_ID = "scenario-inbox-cap-reply-question";

type TriageClassification =
  | "ignore"
  | "info"
  | "notify"
  | "needs_reply"
  | "urgent";

// Classifications that count as "needs the owner's attention now".
const ACT_NOW_CLASSES: ReadonlyArray<TriageClassification> = [
  "needs_reply",
  "urgent",
];

function buildSeedRefs(nowMs: number): Record<string, MessageRef[]> {
  return {
    discord: [
      {
        id: OUTAGE_MSG_ID,
        source: "discord",
        externalId: OUTAGE_MSG_ID,
        from: {
          identifier: "priya-oncall",
          displayName: "Priya (On-Call SRE)",
        },
        to: [{ identifier: "owner" }],
        snippet: "PROD IS DOWN — checkout 500s, approve emergency rollback now",
        body: "PROD IS DOWN — checkout is returning 500s for every customer and revenue has stopped. I need you to approve the emergency rollback right now, we are losing money every minute.",
        receivedAtMs: nowMs - 2 * 60_000,
        hasAttachments: false,
        isRead: false,
      },
    ],
    gmail: [
      {
        id: NOISE_MSG_ID,
        source: "gmail",
        externalId: NOISE_MSG_ID,
        from: {
          identifier: "deals@shoedeals-newsletter.example",
          displayName: "ShoeDeals Weekly",
        },
        to: [{ identifier: "owner@example.com" }],
        subject: "50% OFF SNEAKERS — This Weekend Only!!!",
        snippet: "50% OFF SNEAKERS — automated promotional newsletter",
        body: "Our biggest sneaker blowout of the season is here! Unsubscribe at any time. This is an automated promotional email. Shop now before these deals are gone forever.",
        receivedAtMs: nowMs - 30 * 60_000,
        hasAttachments: false,
        isRead: false,
      },
    ],
    telegram: [
      {
        id: QUESTION_MSG_ID,
        source: "telegram",
        externalId: QUESTION_MSG_ID,
        from: { identifier: "dana-tg", displayName: "Dana" },
        to: [{ identifier: "owner" }],
        snippet: "Are we still on for the design review tomorrow at 2pm?",
        body: "Hey, are we still on for the design review tomorrow at 2pm? Let me know if that time still works for you or if you want to push it.",
        receivedAtMs: nowMs - 10 * 60_000,
        hasAttachments: false,
        isRead: false,
      },
    ],
  };
}

/**
 * Register scenario-scoped message adapters on the core triage service so the
 * INBOX fan-out (list / summarize / search / triage) sees real cross-channel
 * inbound messages. Adapters answer only this scenario's runtime: the service
 * registry is process-global, so every read is gated on the seeding agentId.
 */
async function seedConnectorAdapters(
  ctx: ScenarioContext,
): Promise<ScenarioCheckResult> {
  const runtime = ctx.runtime;
  if (!runtime) {
    return "inbox-capability seed: scenario runtime unavailable";
  }
  const { getDefaultTriageService } = await import("@elizaos/core");
  const seedAgentId = runtime.agentId;
  const nowMs =
    typeof ctx.now === "string" && Number.isFinite(Date.parse(ctx.now))
      ? Date.parse(ctx.now)
      : Date.now();
  const refsBySource = buildSeedRefs(nowMs);

  const service = getDefaultTriageService();
  for (const [source, refs] of Object.entries(refsBySource)) {
    const adapter: MessageAdapter = {
      source: source as MessageSource,
      isAvailable: (rt) => rt.agentId === seedAgentId,
      capabilities: () => ({
        list: true,
        search: false,
        manage: {},
        send: {},
        worlds: "single",
        channels: "implicit",
      }),
      listMessages: async (rt) => (rt.agentId === seedAgentId ? refs : []),
      getMessage: async (rt, id) =>
        rt.agentId === seedAgentId
          ? (refs.find((ref) => ref.id === id) ?? null)
          : null,
      createDraft: async () => {
        throw new Error("scenario seed adapter does not support drafting");
      },
      sendDraft: async () => {
        throw new Error("scenario seed adapter does not support sending");
      },
    };
    service.register(adapter);
  }
  return undefined;
}

/**
 * Read the persisted triage entries back through the inbox repository and
 * assert the organic planner-driven triage turn persisted one entry per
 * seeded message. This proves the capability path ran end-to-end (fetch ->
 * classify -> persist), not merely that a model call happened.
 */
async function assertOrganicTriagePersisted(
  ctx: ScenarioContext,
): Promise<ScenarioCheckResult> {
  const runtime = ctx.runtime;
  if (!runtime) {
    return "inbox-capability outcome: scenario runtime unavailable";
  }
  const { InboxRepository } = (await import(
    "@elizaos/plugin-inbox/inbox/repository"
  )) as {
    InboxRepository: new (
      rt: unknown,
    ) => {
      getBySourceMessageId: (id: string) => Promise<{
        classification: string;
      } | null>;
    };
  };
  const repo = new InboxRepository(runtime);

  const [outageEntry, noiseEntry, questionEntry] = await Promise.all([
    repo.getBySourceMessageId(OUTAGE_MSG_ID),
    repo.getBySourceMessageId(NOISE_MSG_ID),
    repo.getBySourceMessageId(QUESTION_MSG_ID),
  ]);

  if (!outageEntry || !noiseEntry || !questionEntry) {
    return `inbox-capability outcome: expected a persisted triage entry per seeded message, got outage=${Boolean(
      outageEntry,
    )} noise=${Boolean(noiseEntry)} question=${Boolean(questionEntry)}`;
  }
  if (
    !ACT_NOW_CLASSES.includes(
      outageEntry.classification as TriageClassification,
    )
  ) {
    return `inbox-capability outcome: production-outage DM classified "${outageEntry.classification}", expected one of ${ACT_NOW_CLASSES.join("/")}`;
  }
  return undefined;
}

export default scenario({
  lane: "live-only",
  id: "inbox-triage-capability",
  title:
    "Inbox triage capability routes requests to INBOX and drives the inbox_triage classifier",
  domain: "inbox",
  tags: ["lifeops", "inbox", "inbox_triage", "llm-eval"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      title: "LifeOps Inbox Triage Capability",
    },
  ],
  seed: [
    {
      type: "custom",
      name: "register scenario-scoped cross-channel message adapters",
      apply: seedConnectorAdapters,
    },
  ],
  turns: [
    {
      kind: "message",
      name: "triage-list-inbox",
      text: "Show me my inbox across every channel.",
      // Promoted virtual (INBOX_LIST) or umbrella INBOX with the injected
      // structured discriminator — both shapes carry "action":"list".
      plannerIncludesAll: [/\bINBOX_LIST\b|"action":"list"/],
      plannerExcludes: [/\bCALENDAR(_[A-Z_]+)?\b/, /\bMESSAGE(_[A-Z_]+)?\b/],
    },
    {
      kind: "message",
      name: "triage-summarize-inboxes",
      text: "Summarize all my inboxes for me.",
      plannerIncludesAll: [/\bINBOX_SUMMARIZE\b|"action":"summarize"/],
      plannerExcludes: [/\bCALENDAR(_[A-Z_]+)?\b/, /\bMESSAGE(_[A-Z_]+)?\b/],
    },
    {
      kind: "message",
      name: "triage-search-channels",
      text: "Search every channel for messages about the launch.",
      plannerIncludesAll: [/\bINBOX_SEARCH\b|"action":"search"/, "launch"],
      plannerExcludes: [/\bCALENDAR(_[A-Z_]+)?\b/, /\bMESSAGE(_[A-Z_]+)?\b/],
    },
    {
      kind: "message",
      name: "triage-classify-inbox",
      text: "Triage my inbox and tell me what needs my attention right now.",
      // The capability turn: must reach the `triage` subaction (promoted
      // INBOX_TRIAGE virtual or umbrella with "action":"triage"), which runs
      // the inbox_triage classifier — not the list/summarize reads.
      plannerIncludesAll: [/\bINBOX_TRIAGE\b|"action":"triage"/],
      plannerExcludes: [/\bCALENDAR(_[A-Z_]+)?\b/, /\bMESSAGE(_[A-Z_]+)?\b/],
    },
  ],
  finalChecks: [
    {
      type: "selectedAction",
      name: "inbox action selected for every triage turn",
      actionName: [
        "INBOX",
        "INBOX_LIST",
        "INBOX_SEARCH",
        "INBOX_SUMMARIZE",
        "INBOX_TRIAGE",
      ],
    },
    {
      type: "modelCallOccurred",
      name: "inbox_triage optimized-prompt model call fired",
      purpose: "inbox_triage",
      minCount: 1,
    },
    {
      type: "custom",
      name: "organic triage persisted one entry per seeded message (outage = act-now)",
      predicate: assertOrganicTriagePersisted,
    },
  ],
});
