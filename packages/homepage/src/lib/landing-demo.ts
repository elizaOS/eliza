/**
 * Defines the landing group conversation and the bounded capability contract
 * it may portray. A fresh immediate agent can rely on the current conversation;
 * external actions, durable cross-room memory, and search are not available to
 * this demo.
 */

export const LANDING_DEMO_CAPABILITIES = ["conversation-memory"] as const;

export type LandingDemoCapability = (typeof LANDING_DEMO_CAPABILITIES)[number];

export const LANDING_DEMO_UNSUPPORTED_CLAIM_CATEGORIES = [
  "email",
  "calendar",
  "booking",
  "purchase",
  "reminder",
  "note",
  "external-communication",
  "external-account-or-device",
  "web-search",
  "shell",
  "filesystem",
  "browser-or-cloud-app",
  "coding-execution",
] as const;

export type LandingDemoUnsupportedClaimCategory =
  (typeof LANDING_DEMO_UNSUPPORTED_CLAIM_CATEGORIES)[number];

interface UnsupportedClaimRule {
  category: LandingDemoUnsupportedClaimCategory;
  pattern: RegExp;
}

const UNSUPPORTED_CLAIM_RULES: readonly UnsupportedClaimRule[] = [
  {
    category: "email",
    pattern: /\b(?:e-?mails?|emailed|emailing|inbox|mailbox)\b/i,
  },
  {
    category: "calendar",
    pattern:
      /\b(?:calendar|appointment|meetings?|standup|moved?|reschedule|rescheduled|scheduling)\b|\b(?:i|we)\s+(?:schedule|scheduled|add|added|put|placed)[\s\S]{0,32}\b(?:it|that|this|meeting|appointment|standup|agenda|calendar)\b/i,
  },
  {
    category: "booking",
    pattern: /\b(?:book|booked|booking|reserve|reserved|reservations?)\b/i,
  },
  {
    category: "purchase",
    pattern:
      /\b(?:buy|bought|purchase|purchased|order|ordered|checkout)\b|\b(?:i|we)\s+(?:pay|paid|paying)\b/i,
  },
  {
    category: "reminder",
    pattern: /\b(?:remind|reminded|reminding|reminders?)\b/i,
  },
  {
    category: "note",
    pattern: /\b(?:notes?|notebook|dossier)\b/i,
  },
  {
    category: "external-communication",
    pattern:
      /\b(?:send|sent|texted|texting|direct message|dm|call|called|calling|ring)\b|\b(?:i|we)\s+(?:message|messaged|messaging)\b/i,
  },
  {
    category: "external-account-or-device",
    pattern:
      /\b(?:check(?:ed)?-?in|check(?:ed)?\s+(?:me|you|us|them|him|her)\s+in|grab(?:bed|bing)?[\s\S]{0,40}\b(?:an?\s+|your\s+|their\s+|my\s+|our\s+)?(?:usual\s+)?(?:aisle|window)\s+seat|selected\s+(?:an?\s+)?(?:aisle\s+|window\s+)?seat|seat\s+(?:selected|changed|assigned)|changed?\s+(?:an?\s+)?(?:external\s+)?(?:account|device))\b/i,
  },
  {
    category: "web-search",
    pattern:
      /\b(?:search(?:ed|ing)?|look(?:ed|ing)?\s+up|public sources?|web results?)\b|\b(?:i|we)\s+(?:research|researched|researching)\b/i,
  },
  {
    category: "shell",
    pattern: /\b(?:shell|terminal|command line|npm|bun|git|docker)\b/i,
  },
  {
    category: "filesystem",
    pattern:
      /\b(?:filesystem|files?|folders?|directories|workspace|file path)\b|\b(?:i|we)\s+(?:save|saved|saving)[\s\S]{0,32}\bdocuments?\b/i,
  },
  {
    category: "browser-or-cloud-app",
    pattern:
      /\b(?:browser|cloud app|gmail|google drive|slack|notion|dropbox)\b|\b(?:i|we)\s+(?:open|opened|opening)[\s\S]{0,32}\bcrm\b/i,
  },
  {
    category: "coding-execution",
    pattern:
      /\b(?:ran|run|executed?|built|compiled|deployed|push|pushed|pushing)\b[\s\S]{0,36}\b(?:code|repository|repo|codebase|project|tests?|build|patch)\b/i,
  },
];

/**
 * Return unsupported claims recognized by the landing-copy test guard.
 * This conservative matcher protects a fixed marketing script; it is not an
 * exhaustive natural-language classifier or a runtime security boundary.
 */
export function findUnsupportedLandingDemoClaims(
  text: string,
): LandingDemoUnsupportedClaimCategory[] {
  return UNSUPPORTED_CLAIM_RULES.filter(({ pattern }) =>
    pattern.test(text),
  ).map(({ category }) => category);
}

export interface LandingDemoCard {
  capability: LandingDemoCapability;
  label: string;
  title: string;
  rows: string[];
  status?: string;
  statusKind?: "confirmed" | "open";
}

export type LandingDemoStep =
  | {
      capability: LandingDemoCapability;
      continuation?: boolean;
      kind: "eliza";
      text: string;
    }
  | { kind: "member"; name: string; text: string }
  | { kind: "user"; text: string }
  | {
      capability: LandingDemoCapability;
      kind: "card";
      card: LandingDemoCard;
    };

export type LandingDemoScenarioId =
  | "friends"
  | "co-parenting"
  | "household"
  | "trip"
  | "community";

export interface LandingDemoScenario {
  id: LandingDemoScenarioId;
  label: string;
  roomName: string;
  members: readonly string[];
  steps: readonly LandingDemoStep[];
}

/**
 * Five finite rooms show the same social-agent skill in situations people
 * recognize. Each recap is derived only from messages already visible in that
 * room; changing rooms never implies memory leaking between conversations.
 */
export const LANDING_DEMO_SCENARIOS: readonly LandingDemoScenario[] = [
  {
    id: "friends",
    label: "Friends",
    roomName: "Friday people",
    members: ["Maya", "Leo", "Priya", "Jamie"],
    steps: [
      { kind: "member", name: "Maya", text: "Friday or Saturday?" },
      { kind: "user", text: "Saturday after 7" },
      { kind: "member", name: "Leo", text: "same for me" },
      { kind: "member", name: "Priya", text: "quiet place?" },
      {
        capability: "conversation-memory",
        kind: "eliza",
        text: "Saturday after 7 works so far. Jamie still needs to answer.",
      },
      { kind: "member", name: "Jamie", text: "7:30 works" },
      { kind: "user", text: "great, somewhere quiet" },
      {
        capability: "conversation-memory",
        kind: "card",
        card: {
          capability: "conversation-memory",
          label: "Group plan",
          title: "Saturday · 7:30 PM",
          rows: ["Everyone can make it", "Somewhere quiet", "Open: where?"],
          status: "Updated from this group",
          statusKind: "open",
        },
      },
    ],
  },
  {
    id: "co-parenting",
    label: "Co-parenting",
    roomName: "School week",
    members: ["Maya", "Jamie"],
    steps: [
      { kind: "member", name: "Maya", text: "I can get Ava Thursday at 5" },
      { kind: "user", text: "I'll handle Friday pickup" },
      { kind: "member", name: "Jamie", text: "her blue backpack is packed" },
      { kind: "member", name: "Maya", text: "who has soccer Saturday?" },
      {
        capability: "conversation-memory",
        kind: "eliza",
        text: "Thursday is Maya. Friday is you. Saturday soccer is still open.",
      },
      { kind: "member", name: "Jamie", text: "I can take soccer" },
      {
        capability: "conversation-memory",
        kind: "card",
        card: {
          capability: "conversation-memory",
          label: "This week",
          title: "Pickups covered",
          rows: ["Thu · Maya", "Fri · You", "Sat soccer · Jamie"],
          status: "Updated from this group",
        },
      },
    ],
  },
  {
    id: "household",
    label: "Household",
    roomName: "Home team",
    members: ["Priya", "Leo", "Maya"],
    steps: [
      { kind: "member", name: "Priya", text: "we're low on coffee" },
      { kind: "user", text: "I'll get coffee" },
      { kind: "member", name: "Leo", text: "recycling is out" },
      { kind: "member", name: "Maya", text: "laundry is still running" },
      {
        capability: "conversation-memory",
        kind: "eliza",
        text: "Coffee is yours. Leo did recycling. Laundry still needs finishing.",
      },
      { kind: "user", text: "I can finish it tonight" },
      {
        capability: "conversation-memory",
        kind: "card",
        card: {
          capability: "conversation-memory",
          label: "Home list",
          title: "All covered",
          rows: ["Coffee · You", "Recycling · Leo", "Laundry · You"],
          status: "Updated from this group",
        },
      },
    ],
  },
  {
    id: "trip",
    label: "Trip",
    roomName: "Lisbon trip",
    members: ["Jamie", "Maya", "Priya"],
    steps: [
      { kind: "member", name: "Jamie", text: "I land at 9:40" },
      { kind: "member", name: "Maya", text: "mine gets in at 10:15" },
      { kind: "user", text: "I'll wait and we can leave together" },
      { kind: "member", name: "Priya", text: "I arrive the night before" },
      {
        capability: "conversation-memory",
        kind: "eliza",
        text: "Priya arrives first. Jamie lands at 9:40, Maya at 10:15, and you're waiting.",
      },
      { kind: "member", name: "Jamie", text: "perfect, meet by arrivals" },
      {
        capability: "conversation-memory",
        kind: "card",
        card: {
          capability: "conversation-memory",
          label: "Arrival plan",
          title: "Meet by arrivals",
          rows: ["Jamie · 9:40", "Maya · 10:15", "You · waiting"],
          status: "Kept with this group",
        },
      },
    ],
  },
  {
    id: "community",
    label: "Community",
    roomName: "Garden block",
    members: ["Priya", "Leo", "Maya"],
    steps: [
      { kind: "member", name: "Priya", text: "I can water Tuesday" },
      { kind: "member", name: "Leo", text: "Thursday works for me" },
      { kind: "user", text: "I'll do Saturday" },
      { kind: "member", name: "Maya", text: "north bed still needs someone" },
      {
        capability: "conversation-memory",
        kind: "eliza",
        text: "Tuesday, Thursday, and Saturday are covered. The north bed is still open.",
      },
      { kind: "member", name: "Priya", text: "I can cover that Tuesday too" },
      {
        capability: "conversation-memory",
        kind: "card",
        card: {
          capability: "conversation-memory",
          label: "Garden week",
          title: "Coverage set",
          rows: ["Tue · Priya + north bed", "Thu · Leo", "Sat · You"],
          status: "Updated from this group",
        },
      },
    ],
  },
];

export function landingDemoStepText(step: LandingDemoStep): string {
  if (step.kind !== "card") return step.text;
  return [
    step.card.label,
    step.card.title,
    ...step.card.rows,
    step.card.status ?? "",
  ].join(" ");
}
