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

export const LANDING_DEMO_INTRO: readonly LandingDemoStep[] = [
  { kind: "member", name: "Maya", text: "Friday or Saturday?" },
  { kind: "user", text: "Saturday works after 7" },
  { kind: "member", name: "Leo", text: "same for me" },
  { kind: "member", name: "Priya", text: "I can do Friday, maybe Saturday" },
  {
    capability: "conversation-memory",
    kind: "eliza",
    text: "Saturday after 7 is the overlap so far. Jamie still needs to answer.",
  },
  {
    capability: "conversation-memory",
    kind: "card",
    card: {
      capability: "conversation-memory",
      label: "Working plan",
      title: "Saturday evening",
      rows: ["3 can make it", "Waiting on Jamie", "Open: where?"],
      status: "Kept with this group",
      statusKind: "open",
    },
  },
  { kind: "member", name: "Jamie", text: "Saturday works. 7:30?" },
  { kind: "user", text: "yes. somewhere quiet" },
  { kind: "member", name: "Maya", text: "outdoors if it's nice?" },
  {
    capability: "conversation-memory",
    kind: "eliza",
    text: "Saturday at 7:30 works for everyone.",
  },
  {
    capability: "conversation-memory",
    continuation: true,
    kind: "eliza",
    text: "Quiet, with outdoor seating if the weather's good.",
  },
  {
    capability: "conversation-memory",
    kind: "card",
    card: {
      capability: "conversation-memory",
      label: "Group plan",
      title: "Saturday at 7:30 PM",
      rows: [
        "Everyone can make it",
        "Quiet + outdoor option",
        "Open: neighborhood",
      ],
      status: "Updated from this group",
      statusKind: "open",
    },
  },
  { kind: "member", name: "Leo", text: "Mission or Noe Valley" },
  { kind: "user", text: "what's settled?" },
  {
    capability: "conversation-memory",
    kind: "eliza",
    text: "Saturday at 7:30, somewhere quiet with an outdoor option.",
  },
  {
    capability: "conversation-memory",
    continuation: true,
    kind: "eliza",
    text: "The neighborhood is still between Mission and Noe Valley.",
  },
  {
    capability: "conversation-memory",
    kind: "card",
    card: {
      capability: "conversation-memory",
      label: "Open decision",
      title: "Pick the neighborhood",
      rows: ["Mission", "Noe Valley"],
      status: "Waiting on the group",
      statusKind: "open",
    },
  },
];

export const LANDING_DEMO_LOOP: readonly LandingDemoStep[] = [
  { kind: "member", name: "Priya", text: "Noe Valley has my vote" },
  { kind: "user", text: "same" },
  {
    capability: "conversation-memory",
    kind: "eliza",
    text: "Noe Valley is ahead so far. Jamie and Maya haven't picked yet.",
  },
  { kind: "member", name: "Jamie", text: "Noe Valley for me too" },
  { kind: "member", name: "Maya", text: "works for me" },
  {
    capability: "conversation-memory",
    kind: "eliza",
    text: "Noe Valley it is. The restaurant is the last open choice.",
  },
  {
    capability: "conversation-memory",
    kind: "card",
    card: {
      capability: "conversation-memory",
      label: "Current plan",
      title: "Noe Valley · Saturday 7:30",
      rows: [
        "Everyone can make it",
        "Quiet + outdoor option",
        "Open: restaurant",
      ],
      status: "Updated from this group",
      statusKind: "open",
    },
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
