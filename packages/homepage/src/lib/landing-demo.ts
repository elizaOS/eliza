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
      {
        capability: "conversation-memory",
        kind: "card",
        card: {
          capability: "conversation-memory",
          label: "Availability match",
          title: "Saturday is the overlap",
          rows: ["After 7", "Maya, Leo + you", "Waiting on Jamie"],
          status: "Waiting on the group",
          statusKind: "open",
        },
      },
      { kind: "member", name: "Jamie", text: "7:30 works" },
      { kind: "user", text: "great, somewhere quiet" },
      { kind: "member", name: "Maya", text: "outdoors if it's warm?" },
      { kind: "member", name: "Leo", text: "Mission or Noe?" },
      {
        capability: "conversation-memory",
        kind: "eliza",
        text: "Everyone can make 7:30. Quiet and outdoors if it's warm. Mission or Noe is still open.",
      },
      {
        capability: "conversation-memory",
        kind: "card",
        card: {
          capability: "conversation-memory",
          label: "Best fit",
          title: "Saturday · 7:30 PM",
          rows: [
            "Everyone can make it",
            "Quiet + outdoor option",
            "Neighborhood still open",
          ],
          status: "Updated from this group",
          statusKind: "open",
        },
      },
      { kind: "member", name: "Maya", text: "Noe for me" },
      { kind: "member", name: "Leo", text: "same if we can get a big table" },
      {
        capability: "conversation-memory",
        kind: "eliza",
        text: "Noe leads 2–0. If Priya, Jamie, and you are neutral, that settles it. Any objections?",
      },
      {
        capability: "conversation-memory",
        kind: "card",
        card: {
          capability: "conversation-memory",
          label: "Decision check",
          title: "Noe leads 2–0",
          rows: ["No objections yet", "3 people still to weigh in"],
          status: "Waiting on the group",
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
      {
        capability: "conversation-memory",
        kind: "card",
        card: {
          capability: "conversation-memory",
          label: "Handoff map",
          title: "Two pickups covered",
          rows: ["Thu · Maya", "Fri · You", "Sat soccer · Open"],
          status: "Waiting on the group",
          statusKind: "open",
        },
      },
      { kind: "member", name: "Jamie", text: "I can take soccer" },
      { kind: "user", text: "I'll bring her cleats Friday" },
      {
        kind: "member",
        name: "Maya",
        text: "permission slip is in the side pocket",
      },
      { kind: "member", name: "Jamie", text: "I'll handle the team snack too" },
      {
        capability: "conversation-memory",
        kind: "eliza",
        text: "Pickups and soccer are covered. The backpack, cleats, permission slip, and snack are accounted for.",
      },
      {
        capability: "conversation-memory",
        kind: "card",
        card: {
          capability: "conversation-memory",
          label: "Whole week",
          title: "Handoffs covered",
          rows: [
            "Thu pickup · Maya",
            "Fri pickup + cleats · You",
            "Sat soccer + snack · Jamie",
            "Backpack is ready",
          ],
          status: "Updated from this group",
        },
      },
      {
        kind: "member",
        name: "Maya",
        text: "if work runs late Thursday I'll say here",
      },
      { kind: "user", text: "I can be backup until 5:30" },
      {
        capability: "conversation-memory",
        kind: "eliza",
        text: "Maya owns Thursday pickup and you're backup until 5:30. Friday and Saturday stay covered as planned.",
      },
      {
        capability: "conversation-memory",
        kind: "card",
        card: {
          capability: "conversation-memory",
          label: "Backup plan",
          title: "Thursday has a fallback",
          rows: [
            "Primary · Maya at 5",
            "Backup · You until 5:30",
            "Fri + Sat covered",
          ],
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
      {
        capability: "conversation-memory",
        kind: "card",
        card: {
          capability: "conversation-memory",
          label: "Load check",
          title: "One thing still open",
          rows: ["Coffee · You", "Recycling · Leo", "Laundry · Open"],
          status: "Waiting on the group",
          statusKind: "open",
        },
      },
      { kind: "user", text: "I can finish it tonight" },
      { kind: "member", name: "Priya", text: "dishwasher is clean" },
      { kind: "member", name: "Leo", text: "I'll unload it after work" },
      { kind: "member", name: "Maya", text: "I watered the plants" },
      {
        capability: "conversation-memory",
        kind: "eliza",
        text: "Everything is covered: coffee and laundry are yours, Leo has the dishwasher, and Maya did the plants.",
      },
      {
        capability: "conversation-memory",
        kind: "card",
        card: {
          capability: "conversation-memory",
          label: "Chore balance",
          title: "All covered",
          rows: [
            "Coffee + laundry · You",
            "Recycling + dishwasher · Leo",
            "Plants · Maya",
          ],
          status: "Updated from this group",
        },
      },
      { kind: "member", name: "Priya", text: "trash bags are almost out" },
      {
        capability: "conversation-memory",
        kind: "eliza",
        text: "You already have coffee and laundry. Leo, can trash bags ride with your trip home?",
      },
      { kind: "member", name: "Leo", text: "yeah, I'll grab them" },
      {
        capability: "conversation-memory",
        kind: "card",
        card: {
          capability: "conversation-memory",
          label: "Fair split",
          title: "No one gets everything",
          rows: [
            "Coffee + laundry · You",
            "Trash bags + dishwasher · Leo",
            "Plants · Maya",
          ],
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
      {
        capability: "conversation-memory",
        kind: "card",
        card: {
          capability: "conversation-memory",
          label: "Arrival sequence",
          title: "Morning arrivals",
          rows: ["Priya · Night before", "Jamie · 9:40", "Maya · 10:15"],
          status: "Kept with this group",
        },
      },
      { kind: "member", name: "Jamie", text: "perfect, meet by arrivals" },
      { kind: "member", name: "Maya", text: "look for my giant red suitcase" },
      { kind: "user", text: "then straight to the apartment?" },
      { kind: "member", name: "Priya", text: "yep, I have the keys" },
      {
        capability: "conversation-memory",
        kind: "eliza",
        text: "Meet by arrivals after Maya lands, find the red suitcase, then head to the apartment. Priya has the keys.",
      },
      {
        capability: "conversation-memory",
        kind: "card",
        card: {
          capability: "conversation-memory",
          label: "Shared route",
          title: "Airport to apartment",
          rows: [
            "Meet by arrivals",
            "Look for the red suitcase",
            "Apartment keys · Priya",
          ],
          status: "Updated from this group",
        },
      },
      { kind: "member", name: "Jamie", text: "what if Maya's flight is late?" },
      {
        kind: "member",
        name: "Maya",
        text: "wait 30, then go ahead without me",
      },
      {
        capability: "conversation-memory",
        kind: "eliza",
        text: "If Maya isn't out by 10:45, Jamie and you head to the apartment. Priya has the keys, and Maya can follow.",
      },
      {
        capability: "conversation-memory",
        kind: "card",
        card: {
          capability: "conversation-memory",
          label: "Delay plan",
          title: "10:45 cutoff",
          rows: [
            "Jamie + you · Go ahead",
            "Priya · Has the keys",
            "Maya · Follows after landing",
          ],
          status: "Updated from this group",
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
      {
        capability: "conversation-memory",
        kind: "card",
        card: {
          capability: "conversation-memory",
          label: "Coverage map",
          title: "One spot still open",
          rows: ["Tue · Priya", "Thu · Leo", "Sat · You", "North bed · Open"],
          status: "Waiting on the group",
          statusKind: "open",
        },
      },
      { kind: "member", name: "Priya", text: "I can cover that Tuesday too" },
      { kind: "member", name: "Maya", text: "I'll bring the extra hose" },
      {
        kind: "member",
        name: "Leo",
        text: "seedlings need shade cloth Thursday",
      },
      { kind: "user", text: "I can drop it off Wednesday" },
      {
        capability: "conversation-memory",
        kind: "eliza",
        text: "The full week is covered. Priya has the north bed, Maya has the hose, and you'll drop off shade cloth Wednesday.",
      },
      {
        capability: "conversation-memory",
        kind: "card",
        card: {
          capability: "conversation-memory",
          label: "Fewest trips",
          title: "Coverage set",
          rows: [
            "Tue · Priya + north bed",
            "Wed · Shade cloth from you",
            "Thu · Leo",
            "Sat · You",
          ],
          status: "Updated from this group",
        },
      },
      { kind: "member", name: "Leo", text: "west bed looks dry too" },
      {
        capability: "conversation-memory",
        kind: "eliza",
        text: "You're already there Saturday. Can you add the west bed so Priya doesn't need a second trip?",
      },
      { kind: "user", text: "yes, I'll check both" },
      {
        capability: "conversation-memory",
        kind: "card",
        card: {
          capability: "conversation-memory",
          label: "Least extra travel",
          title: "West bed added Saturday",
          rows: [
            "Owner · You",
            "Priya avoids a second trip",
            "Rest of week covered",
          ],
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
