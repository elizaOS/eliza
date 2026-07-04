/**
 * Live-model outcome scenario for the LifeOps `inbox_triage` capability: seeds
 * three cross-channel inbound messages, runs the REAL LLM triage classifier
 * (InboxService.triage -> classifyMessages, purpose:"inbox_triage") via the
 * apply(ctx) seed seam, and asserts the persisted classification — the
 * production-outage Discord DM lands `urgent`, the newsletter lands low-priority
 * noise, the Telegram question lands `needs_reply`. Verified by reading entries
 * back (InboxRepository.getByClassification) and via the inboxTriage provider
 * surfacing the urgent sender.
 */
import type {
  ScenarioCheckResult,
  ScenarioContext,
} from "@elizaos/scenario-runner/schema";
import { scenario } from "@elizaos/scenario-runner/schema";

// Stable source-message ids so the seed write and the finalCheck readback agree.
const URGENT_MSG_ID = "scenario-inbox-urgent-outage";
const NOISE_MSG_ID = "scenario-inbox-noise-newsletter";
const REPLY_MSG_ID = "scenario-inbox-reply-question";

type TriageClassification =
  | "ignore"
  | "info"
  | "notify"
  | "needs_reply"
  | "urgent";

// Classifications that count as "low-priority noise" — anything the inbox view
// keeps but that must NOT surface as an act-now item.
const NOISE_CLASSES: ReadonlyArray<TriageClassification> = [
  "ignore",
  "info",
  "notify",
];
// Classifications that count as "needs the owner's attention now".
const ACT_NOW_CLASSES: ReadonlyArray<TriageClassification> = [
  "needs_reply",
  "urgent",
];

/**
 * Seed three cross-channel inbound messages and run the real triage classifier
 * over them. Persists one triage entry per message via the live LLM. Returns an
 * error string (failing the scenario at seed time) if the obviously-urgent
 * message is not classified as an act-now item — that is the live-model gate.
 */
async function seedAndRunTriage(
  ctx: ScenarioContext,
): Promise<ScenarioCheckResult> {
  const runtime = ctx.runtime;
  if (!runtime) {
    return "inbox-triage seed: scenario runtime unavailable";
  }
  // Narrow service subpath: avoids pulling the inbox React view / register
  // side-effect that the package root (`@elizaos/plugin-inbox`) imports.
  const { InboxService } = (await import(
    "@elizaos/plugin-inbox/inbox/service"
  )) as {
    InboxService: new (
      rt: unknown,
    ) => {
      triage: (
        messages: Array<Record<string, unknown>>,
      ) => Promise<{ triaged: Array<{ classification: string }> }>;
    };
  };

  const nowMs =
    typeof ctx.now === "string" && Number.isFinite(Date.parse(ctx.now))
      ? Date.parse(ctx.now)
      : Date.now();

  const inbound: Array<Record<string, unknown>> = [
    {
      id: URGENT_MSG_ID,
      source: "discord",
      senderName: "Priya (On-Call SRE)",
      channelName: "Direct Message",
      channelType: "dm",
      text: "PROD IS DOWN — checkout is returning 500s for every customer and revenue has stopped. I need you to approve the emergency rollback right now, we are losing money every minute.",
      snippet: "PROD IS DOWN — checkout 500s, approve emergency rollback now",
      timestamp: nowMs - 2 * 60_000,
    },
    {
      id: NOISE_MSG_ID,
      source: "gmail",
      senderName: "ShoeDeals Weekly",
      senderEmail: "deals@shoedeals-newsletter.example",
      channelName: "50% OFF SNEAKERS — This Weekend Only!!!",
      channelType: "dm",
      text: "Our biggest sneaker blowout of the season is here! Unsubscribe at any time. This is an automated promotional email. Shop now before these deals are gone forever.",
      snippet: "50% OFF SNEAKERS — automated promotional newsletter",
      timestamp: nowMs - 30 * 60_000,
    },
    {
      id: REPLY_MSG_ID,
      source: "telegram",
      senderName: "Dana",
      channelName: "Dana",
      channelType: "dm",
      text: "Hey, are we still on for the design review tomorrow at 2pm? Let me know if that time still works for you or if you want to push it.",
      snippet: "Are we still on for the design review tomorrow at 2pm?",
      timestamp: nowMs - 10 * 60_000,
    },
  ];

  const service = new InboxService(runtime);
  const { triaged } = await service.triage(inbound);

  if (triaged.length !== inbound.length) {
    return `inbox-triage seed: expected ${inbound.length} classifications, got ${triaged.length}`;
  }
  // Live-model gate at seed time: the production-outage DM must be an act-now
  // classification. (The fine-grained per-message assertions live in the
  // finalCheck so they read back from the persisted table, not the in-memory
  // result.)
  const urgentDecision = triaged[0]?.classification;
  if (!ACT_NOW_CLASSES.includes(urgentDecision as TriageClassification)) {
    return `inbox-triage seed: production-outage DM classified "${urgentDecision}", expected one of ${ACT_NOW_CLASSES.join("/")}`;
  }
  return undefined;
}

/**
 * Read the persisted triage entries back through the inbox repository and assert
 * the actual per-message classification result. This is the durable outcome
 * check: it does not look at routing or selected actions, only at the rows the
 * classifier wrote to `app_inbox.life_inbox_triage_entries`.
 */
async function assertPersistedClassifications(
  ctx: ScenarioContext,
): Promise<ScenarioCheckResult> {
  const runtime = ctx.runtime;
  if (!runtime) {
    return "inbox-triage outcome: scenario runtime unavailable";
  }
  const { InboxRepository } = (await import(
    "@elizaos/plugin-inbox/inbox/repository"
  )) as {
    InboxRepository: new (
      rt: unknown,
    ) => {
      getBySourceMessageId: (id: string) => Promise<{
        classification: string;
        urgency: string;
        senderName: string | null;
      } | null>;
    };
  };
  const repo = new InboxRepository(runtime);

  const [urgentEntry, noiseEntry, replyEntry] = await Promise.all([
    repo.getBySourceMessageId(URGENT_MSG_ID),
    repo.getBySourceMessageId(NOISE_MSG_ID),
    repo.getBySourceMessageId(REPLY_MSG_ID),
  ]);

  if (!urgentEntry || !noiseEntry || !replyEntry) {
    return `inbox-triage outcome: expected a persisted entry per message, got urgent=${Boolean(
      urgentEntry,
    )} noise=${Boolean(noiseEntry)} reply=${Boolean(replyEntry)}`;
  }

  // 1. The production-outage DM is classified urgent.
  if (urgentEntry.classification !== "urgent") {
    return `inbox-triage outcome: production-outage DM classified "${urgentEntry.classification}", expected "urgent"`;
  }
  // 2. The automated newsletter is low-priority noise, NOT an act-now item.
  if (
    !NOISE_CLASSES.includes(noiseEntry.classification as TriageClassification)
  ) {
    return `inbox-triage outcome: automated newsletter classified "${noiseEntry.classification}", expected one of ${NOISE_CLASSES.join("/")} (must not be act-now)`;
  }
  // 3. The Telegram scheduling question wants a reply (or is urgent), never noise.
  if (
    !ACT_NOW_CLASSES.includes(replyEntry.classification as TriageClassification)
  ) {
    return `inbox-triage outcome: scheduling question classified "${replyEntry.classification}", expected one of ${ACT_NOW_CLASSES.join("/")}`;
  }

  return undefined;
}

export default scenario({
  lane: "live-only",
  id: "inbox-triage-classification-outcome",
  title:
    "Inbox triage classifies seeded cross-channel messages (urgent vs noise) and persists the decision",
  domain: "inbox",
  tags: ["lifeops", "inbox", "inbox_triage", "llm-eval", "outcome"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      title: "LifeOps Inbox Triage Classification Outcome",
    },
  ],
  seed: [
    {
      type: "custom",
      name: "seed cross-channel inbox and run live triage classifier",
      apply: seedAndRunTriage,
    },
  ],
  turns: [
    {
      kind: "message",
      name: "ask what is urgent in the inbox",
      room: "main",
      text: "What's urgent in my inbox right now, and what can I ignore?",
      // The inboxTriage provider injects the persisted urgent / needs_reply
      // entries into owner context, so the answer must surface the outage DM
      // sender and must not promote the automated newsletter as urgent.
      responseIncludesAny: ["Priya", "prod", "rollback", "outage", "checkout"],
      responseExcludes: ["ShoeDeals", "SNEAKERS"],
    },
  ],
  finalChecks: [
    {
      type: "modelCallOccurred",
      name: "inbox_triage optimized-prompt model call fired",
      purpose: "inbox_triage",
      minCount: 1,
    },
    {
      type: "custom",
      name: "persisted triage decisions: outage=urgent, newsletter=noise, question=needs_reply",
      predicate: assertPersistedClassifications,
    },
  ],
});
