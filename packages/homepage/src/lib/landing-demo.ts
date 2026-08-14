/**
 * Defines the landing conversation and the bounded capability contract it may
 * portray. After the personal Shared rollback, a fresh immediate agent can
 * only rely on the current conversation; external actions and search are not
 * available to this demo.
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
}

export type LandingDemoStep =
  | {
      capability: LandingDemoCapability;
      continuation?: boolean;
      kind: "eliza";
      text: string;
    }
  | { kind: "user"; text: string }
  | {
      capability: LandingDemoCapability;
      kind: "card";
      card: LandingDemoCard;
    };

export const LANDING_DEMO_INTRO: readonly LandingDemoStep[] = [
  {
    capability: "conversation-memory",
    kind: "eliza",
    text: "Hey, it's Eliza. Tell me what matters and I'll keep it in this conversation.",
  },
  { kind: "user", text: "my dad and I are planning Rome in October" },
  {
    capability: "conversation-memory",
    kind: "eliza",
    text: "Got it: Rome in October with your dad.",
  },
  {
    capability: "conversation-memory",
    continuation: true,
    kind: "eliza",
    text: "What kind of places does he enjoy?",
  },
  { kind: "user", text: "quiet streets, old bookstores, great coffee" },
  {
    capability: "conversation-memory",
    kind: "eliza",
    text: "I'll keep those preferences with the trip details in this conversation.",
  },
  { kind: "user", text: "he also likes early mornings and avoids crowds" },
  {
    capability: "conversation-memory",
    kind: "eliza",
    text: "Understood.",
  },
  {
    capability: "conversation-memory",
    continuation: true,
    kind: "eliza",
    text: "Here's the context you've shared so far.",
  },
  {
    capability: "conversation-memory",
    kind: "card",
    card: {
      capability: "conversation-memory",
      label: "Conversation context",
      title: "Rome in October",
      rows: ["Traveling with Dad"],
      status: "In this chat",
    },
  },
  {
    capability: "conversation-memory",
    kind: "card",
    card: {
      capability: "conversation-memory",
      label: "Conversation context",
      title: "What Dad enjoys",
      rows: ["Quiet streets and old bookstores", "Great coffee"],
      status: "In this chat",
    },
  },
  {
    capability: "conversation-memory",
    kind: "card",
    card: {
      capability: "conversation-memory",
      label: "Conversation context",
      title: "Pace",
      rows: ["Early mornings", "Avoid crowded places"],
      status: "In this chat",
    },
  },
  { kind: "user", text: "what have I told you so far?" },
  {
    capability: "conversation-memory",
    kind: "eliza",
    text: "Rome in October with your dad.",
  },
  {
    capability: "conversation-memory",
    continuation: true,
    kind: "eliza",
    text: "He likes quiet streets, old bookstores, great coffee, and early mornings without crowds.",
  },
  { kind: "user", text: "perfect, we'll start with Monti" },
  {
    capability: "conversation-memory",
    kind: "eliza",
    text: "Got it. Monti is your starting point for this trip conversation.",
  },
];

export const LANDING_DEMO_LOOP: readonly LandingDemoStep[] = [
  { kind: "user", text: "what did I say my dad likes?" },
  {
    capability: "conversation-memory",
    kind: "eliza",
    text: "Quiet streets, old bookstores, great coffee, and early mornings without crowds.",
  },
  { kind: "user", text: "and where did we decide to start?" },
  {
    capability: "conversation-memory",
    kind: "eliza",
    text: "Monti is the starting point you chose for the Rome trip.",
  },
  { kind: "user", text: "sum up the trip context in one sentence" },
  {
    capability: "conversation-memory",
    kind: "eliza",
    text: "A quiet October trip to Rome with your dad, starting in Monti and shaped around bookstores, coffee, and uncrowded mornings.",
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
