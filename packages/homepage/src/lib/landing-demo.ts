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
    text: "Hey, it's Eliza. What's on your plate?",
  },
  { kind: "user", text: "dinner for four on Thursday" },
  {
    capability: "conversation-memory",
    kind: "eliza",
    text: "Got it. Thursday dinner for four.",
  },
  {
    capability: "conversation-memory",
    continuation: true,
    kind: "eliza",
    text: "What matters most?",
  },
  { kind: "user", text: "Italian, quiet, around 7:30" },
  {
    capability: "conversation-memory",
    kind: "eliza",
    text: "Perfect. I'll keep that together while we plan.",
  },
  {
    capability: "conversation-memory",
    kind: "card",
    card: {
      capability: "conversation-memory",
      label: "Dinner plan",
      title: "Thursday at 7:30 PM",
      rows: ["Italian and quiet", "Party of 4"],
      status: "Kept in this conversation",
    },
  },
  { kind: "user", text: "I also fly to San Francisco Friday morning" },
  {
    capability: "conversation-memory",
    kind: "eliza",
    text: "Okay. Dinner Thursday, then San Francisco Friday morning.",
  },
  {
    capability: "conversation-memory",
    kind: "card",
    card: {
      capability: "conversation-memory",
      label: "Trip context",
      title: "San Francisco",
      rows: ["Friday morning", "After Thursday dinner"],
      status: "Kept in this conversation",
    },
  },
  { kind: "user", text: "and remember I hate early flights" },
  {
    capability: "conversation-memory",
    kind: "eliza",
    text: "Noted.",
  },
  {
    capability: "conversation-memory",
    continuation: true,
    kind: "eliza",
    text: "I'll keep that preference in this conversation.",
  },
  {
    capability: "conversation-memory",
    kind: "card",
    card: {
      capability: "conversation-memory",
      label: "Travel preference",
      title: "Flight timing",
      rows: ["Avoid early departures"],
      status: "Kept in this conversation",
    },
  },
  { kind: "user", text: "what's the plan again?" },
  {
    capability: "conversation-memory",
    kind: "eliza",
    text: "Quiet Italian dinner for four Thursday at 7:30.",
  },
  {
    capability: "conversation-memory",
    continuation: true,
    kind: "eliza",
    text: "Then San Francisco Friday morning, but not too early.",
  },
];

export const LANDING_DEMO_LOOP: readonly LandingDemoStep[] = [
  { kind: "user", text: "what do you remember about dinner?" },
  {
    capability: "conversation-memory",
    kind: "eliza",
    text: "Thursday at 7:30, somewhere Italian and quiet, for four people.",
  },
  { kind: "user", text: "and the flight?" },
  {
    capability: "conversation-memory",
    kind: "eliza",
    text: "Friday morning to San Francisco. You don't want an early departure.",
  },
  { kind: "user", text: "put it all together" },
  {
    capability: "conversation-memory",
    kind: "eliza",
    text: "Quiet Italian dinner Thursday, then a not-too-early flight to San Francisco Friday.",
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
