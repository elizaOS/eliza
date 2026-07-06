/**
 * Deterministic backdated chat-history generator + seeder for message search.
 * Produces N web-chat conversations × M messages spread across a configurable
 * span (default 13 months) with realistic topical text and per-conversation
 * derived owner facts, then lands them through the runtime as real rooms in
 * the agent's web-chat world (`web-conv-*` channel ids) with real backdated
 * `createdAt` values — so `restoreConversationsFromDb` rebuilds them as
 * ordinary conversations and time-window searches ("messages from a year
 * ago") have a corpus to hit.
 *
 * Consumed by the dev-only seed route in `conversation-routes.ts`, by the
 * scenario-runner `messages` seed step, and by
 * `packages/scripts/seed-message-corpus.mjs` for manual demo prep. Generation
 * is a pure function of (seed, now, shape options); ids are random so
 * re-seeding adds more history instead of colliding.
 */
import { randomUUID } from "node:crypto";
import {
  ChannelType,
  MESSAGE_SOURCE_CLIENT_CHAT,
  type Memory,
  MemoryType,
  stringToUuid,
  type UUID,
} from "@elizaos/core";

export interface MessageCorpusOptions {
  /** Number of conversations to generate. */
  conversationCount?: number;
  /** Messages per conversation (user/assistant alternating). */
  messagesPerConversation?: number;
  /** Months of history to spread conversation start times across. */
  spanMonths?: number;
  /** Derived owner facts written per conversation. */
  factsPerConversation?: number;
  /** RNG seed — same seed + now yields byte-identical text and timestamps. */
  seed?: number;
  /** Anchor timestamp (epoch ms) the span counts back from. */
  now?: number;
}

export interface GeneratedCorpusMessage {
  role: "user" | "assistant";
  text: string;
  createdAt: number;
}

export interface GeneratedCorpusConversation {
  title: string;
  topic: string;
  createdAt: number;
  messages: GeneratedCorpusMessage[];
  facts: Array<{ text: string; createdAt: number }>;
}

export interface GeneratedMessageCorpus {
  conversations: GeneratedCorpusConversation[];
  /** Distinctive per-topic keywords usable as demo search queries. */
  sampleQueries: string[];
  oldestMessageAt: number;
  newestMessageAt: number;
}

const DEFAULT_CONVERSATIONS = 12;
const DEFAULT_MESSAGES_PER_CONVERSATION = 40;
const DEFAULT_SPAN_MONTHS = 13;
const DEFAULT_FACTS_PER_CONVERSATION = 1;
const DEFAULT_SEED = 1337;
const MONTH_MS = 30 * 24 * 60 * 60 * 1000;

/** mulberry32 — tiny deterministic PRNG; quality is irrelevant, replay is not. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface TopicPack {
  topic: string;
  titles: string[];
  userLines: string[];
  assistantLines: string[];
  facts: string[];
  /**
   * A single distinctive token guaranteed to recur across this pack's lines, so
   * it reliably lands hits. A multi-word phrase would require every term in one
   * message — brittle against generated line variety — so keep it one word.
   */
  sampleQuery: string;
}

// Each pack carries distinctive low-collision keywords (marathon, sourdough,
// canary, …) so demo searches land on the intended topic, and enough line
// variety that FTS ranking has real signal instead of near-identical rows.
const TOPIC_PACKS: TopicPack[] = [
  {
    topic: "fitness",
    titles: ["Marathon training plan", "Long run recap", "Race week prep"],
    userLines: [
      "My long run this weekend was {n} kilometers and my knees are feeling it",
      "Signed up for the Berlin marathon — is a {n} week training block enough?",
      "What should my tempo pace be if my 10k time is {n} minutes?",
      "I skipped two runs this week, how do I get the training plan back on track?",
      "The new running shoes felt great for the first {n} kilometers",
      "Should I do the interval session before or after strength training?",
    ],
    assistantLines: [
      "For marathon training, keep the long run under {n} percent of weekly volume",
      "A negative split strategy works well — go out {n} seconds slower per kilometer",
      "Your taper should start about {n} weeks before race day",
      "Recovery runs should feel easy — conversational pace, roughly {n} minutes per kilometer",
      "Carb loading matters most in the final {n} hours before the marathon",
    ],
    facts: [
      "Owner is training for the Berlin marathon and runs long on weekends",
      "Owner's easy run pace is about six minutes per kilometer",
    ],
    sampleQuery: "marathon",
  },
  {
    topic: "baking",
    titles: [
      "Sourdough starter log",
      "Weekend bake plans",
      "Crumb troubleshooting",
    ],
    userLines: [
      "The sourdough starter doubled in {n} hours today, smells like ripe fruit",
      "My crumb came out dense again — should I extend bulk fermentation?",
      "Tried a {n} percent hydration dough and it was a sticky mess",
      "The oven spring on today's loaf was the best I've ever had",
      "Do I need to feed the starter twice a day in summer?",
      "Scoring pattern collapsed again, the blade keeps dragging",
    ],
    assistantLines: [
      "For an open crumb, push bulk fermentation until the dough grows about {n} percent",
      "A colder proof — {n} hours in the fridge — deepens the sourdough flavor",
      "Sticky dough usually means underdeveloped gluten; add {n} more coil folds",
      "Steam for the first {n} minutes is what gives you that glossy crust",
      "Feed the starter 1:{n}:{n} flour to water when the kitchen runs warm",
    ],
    facts: [
      "Owner keeps a sourdough starter and bakes on weekends",
      "Owner prefers high-hydration open-crumb loaves",
    ],
    sampleQuery: "sourdough",
  },
  {
    topic: "infra",
    titles: [
      "Kubernetes cluster upgrade",
      "Deploy pipeline debugging",
      "Incident postmortem",
    ],
    userLines: [
      "The kubernetes cluster upgrade to {n}.x left two nodes NotReady",
      "Deploy rolled back automatically — the readiness probe timed out after {n} seconds",
      "Should we move the ingress controller before or after the node pool swap?",
      "CI is red again, the integration stage flaked {n} times this week",
      "Postgres connection pool exhausted at {n} connections during the spike",
      "The canary deploy looked healthy for {n} minutes then error rates doubled",
    ],
    assistantLines: [
      "Drain and cordon the NotReady nodes first, then check kubelet logs for certificate errors",
      "Raise the readiness probe initial delay to {n} seconds and watch the rollout",
      "Pin the ingress controller to the stable node pool until the upgrade settles",
      "PgBouncer in transaction mode would cap the pool at {n} without starving workers",
      "A {n} percent canary for thirty minutes is a safer promotion gate",
    ],
    facts: [
      "Owner operates a kubernetes cluster and prefers canary deploys",
      "Owner's production database is Postgres behind a connection pooler",
    ],
    sampleQuery: "canary",
  },
  {
    topic: "finance",
    titles: [
      "Quarterly budget review",
      "Invoice follow-ups",
      "Subscription audit",
    ],
    userLines: [
      "The quarterly budget shows {n} percent overspend on cloud infrastructure",
      "Invoice number {n} from the design contractor is still unpaid",
      "Can we cut the software subscriptions bill? It grew {n} percent this year",
      "Payroll runs on the {n}th — make sure the transfer clears before then",
      "The accountant needs receipts for the March travel by Friday",
      "Revenue landed {n} percent above forecast this quarter",
    ],
    assistantLines: [
      "Cloud spend is driven by the staging environment — shutting it down nights saves about {n} percent",
      "I drafted a reminder for invoice {n}; it is {n} days past due",
      "Three subscriptions overlap in functionality — consolidating saves {n} per month",
      "Flagging the payroll cutoff — initiate the transfer {n} business days early",
      "Categorized the March receipts; two are missing merchant names",
    ],
    facts: [
      "Owner reviews the budget quarterly and tracks cloud spend closely",
      "Owner's payroll runs monthly on a fixed date",
    ],
    sampleQuery: "invoice",
  },
  {
    topic: "travel",
    titles: [
      "Kyoto itinerary",
      "Autumn trip planning",
      "Flight and ryokan bookings",
    ],
    userLines: [
      "Thinking {n} days in Kyoto then the train to Osaka — too rushed?",
      "The ryokan near Arashiyama has an opening the week of the {n}th",
      "Should we book the Shinkansen passes before we land?",
      "Foliage forecast says peak color in Kyoto around late November",
      "Found flights with one stop for {n} less — worth the longer layover?",
      "Add the Fushimi Inari sunrise walk to the itinerary please",
    ],
    assistantLines: [
      "Four nights in Kyoto covers the main temples without rushing — day {n} for Nara",
      "Booked-out ryokan often release rooms {n} days ahead; I can watch for that",
      "Buy the rail pass online first — activation at the airport takes minutes",
      "Sunrise at Fushimi Inari means starting the climb around {n} in the morning",
      "The layover saves money but risks the last airport train; buffer {n} hours",
    ],
    facts: [
      "Owner is planning an autumn trip to Kyoto with a ryokan stay",
      "Owner prefers early-morning sightseeing before crowds",
    ],
    sampleQuery: "kyoto",
  },
  {
    topic: "reading",
    titles: [
      "Book club notes",
      "Reading list triage",
      "Sci-fi recommendations",
    ],
    userLines: [
      "Finished reading Dune last night — the ecology subplot deserved more pages",
      "Book club picked a {n} page biography for next month, wish me luck",
      "Any sci-fi recommendations that feel like Le Guin but newer?",
      "I keep abandoning books at the {n} percent mark, is that a bad habit?",
      "The translation of the novel felt stiff — is the original better regarded?",
      "Reading pace this month: {n} books, mostly on the train",
    ],
    assistantLines: [
      "If you liked Dune's ecology, the Mars trilogy goes even deeper into terraforming",
      "For Le Guin's texture try Ancillary Justice or A Memory Called Empire",
      "Abandoning a book at {n} percent is a verdict, not a failure",
      "Biographies read faster after chapter {n} once the childhood section ends",
      "Your reading log says fiction outnumbers nonfiction {n} to one this year",
    ],
    facts: [
      "Owner is in a monthly book club and favors literary sci-fi",
      "Owner reads mostly during train commutes",
    ],
    sampleQuery: "abandoning",
  },
  {
    topic: "garden",
    titles: ["Tomato seedling log", "Garden bed planning", "Pest patrol"],
    userLines: [
      "The tomato seedlings are {n} centimeters tall and leaning toward the window",
      "Aphids are back on the pepper plants — neem oil again or something stronger?",
      "When should I transplant the seedlings to the raised bed?",
      "The compost thermometer read {n} degrees this morning, is that too hot?",
      "Squirrels dug up two of the bean rows overnight",
      "First ripe tomato of the season — the Sungold beat the Brandywine by weeks",
    ],
    assistantLines: [
      "Leaning seedlings want more light — {n} hours under the grow lamp evens them out",
      "Transplant after the last frost date once nights stay above {n} degrees",
      "Ladybugs clear an aphid flare-up in about {n} days without spraying",
      "Compost above {n} degrees cooks the microbes — turn the pile and add browns",
      "Netting the bean rows tonight; squirrels give up after a week of failure",
    ],
    facts: [
      "Owner grows tomatoes from seed in a raised-bed garden",
      "Owner composts and battles aphids without pesticides",
    ],
    sampleQuery: "seedlings",
  },
  {
    topic: "health",
    titles: ["Sleep schedule reset", "Migraine tracking", "Checkup follow-up"],
    userLines: [
      "Slept {n} hours again — the new schedule isn't sticking",
      "Migraine hit at noon, third one this month, always after skipped lunch",
      "The doctor wants a follow-up blood panel in {n} weeks",
      "Screen time after midnight is clearly wrecking my mornings",
      "Tried the earlier caffeine cutoff and woke up before the alarm",
      "Headache diary says the trigger cluster is stress plus dehydration",
    ],
    assistantLines: [
      "Anchor the wake time first — the sleep time follows within {n} days",
      "Your migraine log shows skipped meals precede {n} of the last episodes",
      "I scheduled the blood panel reminder {n} days out with a fasting note",
      "A hard screens-off at eleven has the strongest evidence in your own data",
      "Hydration plus a mid-morning snack has cut your headache frequency before",
    ],
    facts: [
      "Owner tracks migraines and skipped meals are a known trigger",
      "Owner is resetting their sleep schedule around a fixed wake time",
    ],
    sampleQuery: "migraine",
  },
];

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

function fillTemplate(template: string, rng: () => number): string {
  return template.replace(/\{n\}/g, () => String(2 + Math.floor(rng() * 40)));
}

/**
 * Generate a deterministic backdated corpus. Conversation start times are
 * spread oldest-first across the span ending at `now`, so a span of 13+
 * months guarantees material on both sides of a "one year ago" boundary.
 */
export function generateMessageCorpus(
  options: MessageCorpusOptions = {},
): GeneratedMessageCorpus {
  const conversationCount = options.conversationCount ?? DEFAULT_CONVERSATIONS;
  const messagesPerConversation =
    options.messagesPerConversation ?? DEFAULT_MESSAGES_PER_CONVERSATION;
  const spanMonths = options.spanMonths ?? DEFAULT_SPAN_MONTHS;
  const factsPerConversation =
    options.factsPerConversation ?? DEFAULT_FACTS_PER_CONVERSATION;
  const now = options.now ?? Date.now();
  const rng = mulberry32(options.seed ?? DEFAULT_SEED);

  const spanMs = spanMonths * MONTH_MS;
  const earliest = now - spanMs;
  // Leave headroom after the last conversation start so its messages fit
  // before `now` even at one message per few minutes.
  const startWindow = spanMs - messagesPerConversation * 5 * 60_000 - 60_000;

  const conversations: GeneratedCorpusConversation[] = [];
  let oldestMessageAt = Number.POSITIVE_INFINITY;
  let newestMessageAt = 0;

  for (let i = 0; i < conversationCount; i++) {
    const pack = TOPIC_PACKS[i % TOPIC_PACKS.length];
    // Even spread plus jitter, oldest first.
    const slot = conversationCount === 1 ? 0 : i / (conversationCount - 1);
    const jitter = (rng() - 0.5) * (startWindow / conversationCount);
    const startAt = Math.round(
      Math.min(
        now - messagesPerConversation * 5 * 60_000 - 60_000,
        Math.max(earliest, earliest + slot * startWindow + jitter),
      ),
    );
    const startDate = new Date(startAt);
    const monthName = MONTH_NAMES[startDate.getUTCMonth()];
    const title = `${pack.titles[Math.floor(rng() * pack.titles.length)]} (${monthName} ${startDate.getUTCFullYear()})`;

    const messages: GeneratedCorpusMessage[] = [];
    let at = startAt;
    for (let j = 0; j < messagesPerConversation; j++) {
      const role = j % 2 === 0 ? "user" : "assistant";
      const lines = role === "user" ? pack.userLines : pack.assistantLines;
      const text = fillTemplate(lines[Math.floor(rng() * lines.length)], rng);
      messages.push({ role, text, createdAt: at });
      oldestMessageAt = Math.min(oldestMessageAt, at);
      newestMessageAt = Math.max(newestMessageAt, at);
      // 30s–5min between turns.
      at += 30_000 + Math.floor(rng() * 270_000);
    }

    const facts: Array<{ text: string; createdAt: number }> = [];
    for (let f = 0; f < factsPerConversation; f++) {
      const factText = pack.facts[f % pack.facts.length];
      facts.push({
        text: `${factText} (noted ${monthName} ${startDate.getUTCFullYear()})`,
        createdAt: messages.at(-1)?.createdAt ?? startAt,
      });
    }

    conversations.push({
      title,
      topic: pack.topic,
      createdAt: startAt,
      messages,
      facts,
    });
  }

  return {
    conversations,
    sampleQueries: TOPIC_PACKS.slice(
      0,
      Math.min(conversationCount, TOPIC_PACKS.length),
    ).map((p) => p.sampleQuery),
    oldestMessageAt: Number.isFinite(oldestMessageAt) ? oldestMessageAt : now,
    newestMessageAt,
  };
}

/**
 * The narrow runtime surface the seeder writes through. `AgentRuntime`
 * satisfies it structurally; tests can drive it with a real runtime over an
 * in-memory adapter.
 */
export interface MessageCorpusRuntime {
  agentId: UUID;
  character: { name?: string };
  ensureConnection(params: {
    entityId: UUID;
    roomId: UUID;
    roomName?: string;
    worldId?: UUID;
    userName?: string;
    source?: string;
    type?: ChannelType | string;
    channelId?: string;
    messageServerId?: UUID;
    metadata?: Record<string, unknown>;
  }): Promise<unknown>;
  createMemory(
    memory: Memory,
    tableName: string,
    unique?: boolean,
  ): Promise<UUID>;
}

export interface SeededConversationRef {
  /** Conversation id (the `web-conv-<id>` channel suffix). */
  id: string;
  roomId: UUID;
  title: string;
  topic: string;
  createdAt: number;
  lastMessageAt: number;
}

export interface MessageCorpusSeedSummary {
  conversations: SeededConversationRef[];
  messagesCreated: number;
  factsCreated: number;
  oldestMessageAt: number;
  newestMessageAt: number;
  sampleQueries: string[];
}

/**
 * Land a generated corpus through the runtime as real web-chat conversations:
 * one `web-conv-*` room per conversation in the agent's web-chat world (the
 * exact shape `restoreConversationsFromDb` scans for), user messages authored
 * by a deterministic simulated-owner entity, assistant messages by the agent,
 * and per-conversation derived facts in the `facts` table — all with the
 * corpus's backdated `createdAt` values.
 */
export async function seedMessageCorpus(
  runtime: MessageCorpusRuntime,
  corpus: GeneratedMessageCorpus,
): Promise<MessageCorpusSeedSummary> {
  const agentName = runtime.character.name ?? "Eliza";
  const worldId = stringToUuid(`${agentName}-web-chat-world`);
  const messageServerId = stringToUuid(`${agentName}-web-server`) as UUID;
  const ownerEntityId = stringToUuid(
    `message-corpus-owner-${runtime.agentId}`,
  ) as UUID;

  const seeded: SeededConversationRef[] = [];
  let messagesCreated = 0;
  let factsCreated = 0;

  for (const conversation of corpus.conversations) {
    const conversationId = randomUUID();
    const roomId = stringToUuid(`web-conv-${conversationId}`) as UUID;
    await runtime.ensureConnection({
      entityId: ownerEntityId,
      roomId,
      roomName: conversation.title,
      worldId,
      userName: "Demo Owner",
      source: MESSAGE_SOURCE_CLIENT_CHAT,
      channelId: `web-conv-${conversationId}`,
      type: ChannelType.DM,
      messageServerId,
      metadata: { ownership: { ownerId: ownerEntityId } },
    });

    let lastMessageAt = conversation.createdAt;
    for (const message of conversation.messages) {
      await runtime.createMemory(
        {
          id: randomUUID() as UUID,
          entityId:
            message.role === "assistant" ? runtime.agentId : ownerEntityId,
          agentId: runtime.agentId,
          roomId,
          worldId,
          content: { text: message.text, source: MESSAGE_SOURCE_CLIENT_CHAT },
          metadata: { type: MemoryType.MESSAGE },
          createdAt: message.createdAt,
        },
        "messages",
      );
      messagesCreated += 1;
      lastMessageAt = message.createdAt;
    }

    for (const fact of conversation.facts) {
      // Same durable-fact shape the scenario-runner memory seed writes, so the
      // core FACTS provider retrieves these like extractor-persisted facts.
      await runtime.createMemory(
        {
          id: randomUUID() as UUID,
          entityId: ownerEntityId,
          agentId: runtime.agentId,
          roomId,
          worldId,
          content: { text: fact.text },
          metadata: {
            type: MemoryType.CUSTOM,
            source: "message-corpus-seed",
            confidence: 0.95,
            kind: "durable",
            category: "seeded",
            keywords: [],
          },
          createdAt: fact.createdAt,
        },
        "facts",
        true,
      );
      factsCreated += 1;
    }

    seeded.push({
      id: conversationId,
      roomId,
      title: conversation.title,
      topic: conversation.topic,
      createdAt: conversation.createdAt,
      lastMessageAt,
    });
  }

  return {
    conversations: seeded,
    messagesCreated,
    factsCreated,
    oldestMessageAt: corpus.oldestMessageAt,
    newestMessageAt: corpus.newestMessageAt,
    sampleQueries: corpus.sampleQueries,
  };
}
