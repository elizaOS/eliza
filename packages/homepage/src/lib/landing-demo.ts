/**
 * Defines the landing group conversation and the bounded capability contract
 * it may portray. A fresh immediate agent can rely on the current conversation;
 * connected capabilities are shown only with an explicit source or permission
 * state so the demo never implies silent access.
 */

export const LANDING_DEMO_CAPABILITIES = [
  "conversation-memory",
  "connected-calendar",
  "public-web-search",
  "room-memory",
  "scheduled-reminder",
] as const;

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
  "durable-memory",
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
      /\b(?:search(?:ed|ing)?|look(?:ed|ing)?\s+up|public (?:sources?|web|listings?)|web results?)\b|\b(?:i|we)\s+(?:research|researched|researching)\b/i,
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
  {
    category: "durable-memory",
    pattern:
      /\b(?:household|room|long-term|durable)(?:'s)?\s+(?:memory|saved)\b|\b(?:saved|stored)\b[\s\S]{0,36}\b(?:preference|default|memory)\b|\bremember(?:ed|ing)?\s+(?:this|that)\s+(?:preference|default)\b/i,
  },
];

const ALLOWED_CLAIMS_BY_CAPABILITY: Record<
  LandingDemoCapability,
  readonly LandingDemoUnsupportedClaimCategory[]
> = {
  "conversation-memory": [],
  "connected-calendar": ["calendar"],
  "public-web-search": ["web-search"],
  "room-memory": ["durable-memory"],
  "scheduled-reminder": ["reminder"],
};

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

/**
 * Advanced claims are allowed only when the scripted Eliza step declares the
 * matching capability. Cards must additionally disclose the data source or
 * permission state, which is enforced by the contract test.
 */
export function findUndeclaredLandingDemoClaims(
  step: LandingDemoStep,
): LandingDemoUnsupportedClaimCategory[] {
  const detected = findUnsupportedLandingDemoClaims(landingDemoStepText(step));
  if (step.kind === "member" || step.kind === "user") return [];
  const allowed = ALLOWED_CLAIMS_BY_CAPABILITY[step.capability];
  return detected.filter((category) => !allowed.includes(category));
}

export type LandingDemoSourceKind = "calendar" | "memory" | "reminder" | "web";

export interface LandingDemoSource {
  kind: LandingDemoSourceKind;
  label: string;
}

export interface LandingDemoCard {
  capability: LandingDemoCapability;
  label: string;
  title: string;
  rows: string[];
  status?: string;
  statusKind?: "confirmed" | "open";
  source?: LandingDemoSource;
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

export const LANDING_DEMO_MEMBER_AVATARS = {
  Dev: "/brand/people/demo-dev.webp",
  Eli: "/brand/people/demo-eli.webp",
  Emi: "/brand/people/demo-emi.webp",
  Jamie: "/brand/people/demo-jamie.webp",
  Jules: "/brand/people/demo-jules.webp",
  Leo: "/brand/people/demo-leo.webp",
  Maya: "/brand/people/demo-maya.webp",
  Nina: "/brand/people/demo-nina.webp",
  Noor: "/brand/people/demo-noor.webp",
  Priya: "/brand/people/demo-priya.webp",
  Rosa: "/brand/people/demo-rosa.webp",
  Samira: "/brand/people/demo-samira.webp",
  Tasha: "/brand/people/demo-tasha.webp",
  Theo: "/brand/people/demo-theo.webp",
} as const;

export interface LandingDemoScenario {
  id: LandingDemoScenarioId;
  label: string;
  roomName: string;
  members: readonly string[];
  participantLabel?: string;
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
    roomName: "Friends",
    members: ["Maya", "Leo", "Priya", "Jamie"],
    steps: [
      { kind: "member", name: "Maya", text: "dinner this weekend?" },
      { kind: "user", text: "I'm in" },
      { kind: "member", name: "Leo", text: "same" },
      { kind: "member", name: "Priya", text: "quiet place, ideally outside" },
      {
        capability: "connected-calendar",
        kind: "eliza",
        text: "Saturday after 7 is the only overlap on the calendars you chose to share. Jamie still needs to answer.",
      },
      {
        capability: "connected-calendar",
        kind: "card",
        card: {
          capability: "connected-calendar",
          label: "Availability match",
          title: "Saturday is the overlap",
          rows: ["After 7", "4 people are free", "Waiting on Jamie"],
          source: { kind: "calendar", label: "4 calendars shared" },
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
      {
        kind: "member",
        name: "Priya",
        text: "vegetarian for me",
      },
      { kind: "member", name: "Jamie", text: "same allergy rules as always" },
      {
        capability: "room-memory",
        kind: "eliza",
        text: "Jamie's shared room profile says severe peanut allergy. I'm treating that as a hard constraint, not a preference.",
      },
      {
        capability: "room-memory",
        kind: "card",
        card: {
          capability: "room-memory",
          label: "Group requirements",
          title: "Two dietary constraints",
          rows: [
            "Priya · Vegetarian",
            "Jamie · Severe peanut allergy",
            "Cross-contact must be confirmed",
          ],
          source: {
            kind: "memory",
            label: "Friends memory · shared with room",
          },
          status: "Filtering risky matches",
          statusKind: "open",
        },
      },
      { kind: "member", name: "Maya", text: "Noe for me" },
      { kind: "member", name: "Leo", text: "big table, not loud" },
      {
        capability: "public-web-search",
        kind: "eliza",
        text: "I found Cypress Table in Noe: quiet back patio, vegetarian mains, and a published contact for allergy questions. Jamie's peanut allergy still needs direct confirmation.",
      },
      { kind: "member", name: "Priya", text: "that works for me" },
      { kind: "member", name: "Jamie", text: "only if the kitchen confirms" },
      { kind: "user", text: "safety over patio" },
      {
        capability: "public-web-search",
        kind: "eliza",
        text: "Then Cypress Table is the lead only after confirmation. If not, the indoor backup I found still fits the diet, noise, neighborhood, and 7:30 constraints.",
      },
      {
        capability: "public-web-search",
        kind: "card",
        card: {
          capability: "public-web-search",
          label: "Restaurant match",
          title: "Cypress Table · 7:30 target",
          rows: [
            "Quiet patio + indoor fallback",
            "Vegetarian mains for Priya",
            "Jamie · Peanut protocol to confirm",
            "Backup already shortlisted",
          ],
          source: { kind: "web", label: "Public web · checked now" },
          status: "One safety check before choosing",
          statusKind: "open",
        },
      },
    ],
  },
  {
    id: "co-parenting",
    label: "Co-parenting",
    roomName: "Co-parenting",
    members: ["Nina"],
    participantLabel: "2 parents + Eliza",
    steps: [
      {
        kind: "member",
        name: "Nina",
        text: "Thursday at 5, per the custody calendar",
      },
      { kind: "user", text: "I can cover Friday pickup" },
      { kind: "member", name: "Nina", text: "blue backpack is packed" },
      { kind: "user", text: "soccer is Saturday morning" },
      {
        capability: "connected-calendar",
        kind: "eliza",
        text: "Ava's shared calendar shows soccer Saturday at 9. Thursday and Friday pickups are covered; soccer is still open.",
      },
      {
        capability: "connected-calendar",
        kind: "card",
        card: {
          capability: "connected-calendar",
          label: "Custody logistics",
          title: "Two pickups covered",
          rows: ["Thu · Nina", "Fri · You", "Sat 9 AM soccer · Open"],
          source: { kind: "calendar", label: "Shared family calendar" },
          status: "One adult still needed",
          statusKind: "open",
        },
      },
      {
        kind: "member",
        name: "Nina",
        text: "I can take soccer. no reply needed.",
      },
      { kind: "user", text: "I'll bring her cleats Friday" },
      {
        kind: "member",
        name: "Nina",
        text: "permission slip is in the side pocket. also no reply needed.",
      },
      {
        kind: "user",
        text: "excellent. silence achieved.",
      },
      {
        capability: "conversation-memory",
        kind: "eliza",
        text: "Pickups and soccer are covered. Backpack, cleats, and permission slip are accounted for. No direct negotiation required.",
      },
      {
        capability: "conversation-memory",
        kind: "card",
        card: {
          capability: "conversation-memory",
          label: "Treaty status",
          title: "Everyone knows their job",
          rows: [
            "Thu pickup · Nina",
            "Fri pickup + cleats · You",
            "Sat soccer · Nina",
            "Backpack is ready",
          ],
          status: "Zero extra replies needed",
        },
      },
      {
        kind: "member",
        name: "Nina",
        text: "if work runs late Thursday, one update. no commentary.",
      },
      { kind: "user", text: "I can be backup until 5:30" },
      {
        capability: "conversation-memory",
        kind: "eliza",
        text: "Nina remains primary Thursday; you're backup until 5:30. Friday and Saturday stay covered, and nobody has to renegotiate.",
      },
      {
        capability: "conversation-memory",
        kind: "card",
        card: {
          capability: "conversation-memory",
          label: "Fallback protocol",
          title: "The treaty has a backup",
          rows: [
            "Primary · Nina at 5",
            "Backup · You until 5:30",
            "Fri + Sat covered",
          ],
          status: "No new argument required",
        },
      },
      { kind: "member", name: "Nina", text: "Ava's inhaler is with me" },
      {
        kind: "user",
        text: "front pocket of the blue backpack?",
      },
      {
        kind: "member",
        name: "Nina",
        text: "yes. consensus. unsettling.",
      },
      {
        capability: "scheduled-reminder",
        kind: "eliza",
        text: "Nina packs the inhaler Thursday; you verify it Friday. I folded that check into your existing 4:30 handoff reminder instead of creating another alert.",
      },
      { kind: "user", text: "great. that's one less text." },
      {
        kind: "member",
        name: "Nina",
        text: "cleats stay in the car. permanently.",
      },
      {
        capability: "scheduled-reminder",
        kind: "eliza",
        text: "Friday's 4:30 reminder now includes the inhaler check. Nobody needs to text anyone twice.",
      },
      {
        capability: "scheduled-reminder",
        kind: "card",
        card: {
          capability: "scheduled-reminder",
          label: "Peacekeeping checklist",
          title: "Ava has what she needs",
          rows: [
            "Thu · Nina packs inhaler",
            "Fri 4:30 · Verify inhaler",
            "Cleats · Stay in the car",
            "Backpack · Already packed",
          ],
          source: {
            kind: "reminder",
            label: "Your reminders · already allowed",
          },
          status: "One reminder, zero follow-ups",
        },
      },
    ],
  },
  {
    id: "household",
    label: "Household",
    roomName: "Household",
    members: ["Noor", "Eli", "Jules"],
    steps: [
      { kind: "member", name: "Noor", text: "we're low on coffee" },
      { kind: "user", text: "I'll get coffee; we always buy oat milk" },
      { kind: "member", name: "Eli", text: "recycling is out" },
      { kind: "member", name: "Jules", text: "laundry is still running" },
      {
        capability: "room-memory",
        kind: "eliza",
        text: "Coffee is yours. Oat milk stays the household default. Eli did recycling; laundry is still open.",
      },
      {
        capability: "room-memory",
        kind: "card",
        card: {
          capability: "room-memory",
          label: "Load check",
          title: "One thing still open",
          rows: ["Coffee · You", "Recycling · Eli", "Laundry · Open"],
          source: { kind: "memory", label: "Household memory · room only" },
          status: "Waiting on the group",
          statusKind: "open",
        },
      },
      { kind: "user", text: "I can finish it tonight" },
      { kind: "member", name: "Noor", text: "dishwasher is clean" },
      { kind: "member", name: "Eli", text: "I'll unload it after work" },
      { kind: "member", name: "Jules", text: "I watered the plants" },
      {
        capability: "conversation-memory",
        kind: "eliza",
        text: "Everything is covered: coffee and laundry are yours, Eli has the dishwasher, and Jules did the plants.",
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
            "Recycling + dishwasher · Eli",
            "Plants · Jules",
          ],
          status: "Updated from this group",
        },
      },
      { kind: "member", name: "Noor", text: "trash bags are almost out" },
      {
        capability: "conversation-memory",
        kind: "eliza",
        text: "You already have coffee and laundry. Eli, can trash bags ride with your trip home?",
      },
      { kind: "member", name: "Eli", text: "yeah, I'll grab them" },
      {
        capability: "conversation-memory",
        kind: "card",
        card: {
          capability: "conversation-memory",
          label: "Fair split",
          title: "No one gets everything",
          rows: [
            "Coffee + laundry · You",
            "Trash bags + dishwasher · Eli",
            "Plants · Jules",
          ],
          status: "Updated from this group",
        },
      },
      {
        kind: "member",
        name: "Jules",
        text: "we also need dinner groceries",
      },
      {
        kind: "member",
        name: "Noor",
        text: "I can shop if we keep the list short",
      },
      { kind: "user", text: "pasta tonight" },
      {
        capability: "room-memory",
        kind: "eliza",
        text: "The usual pasta list is pasta, tomatoes, parmesan, and oat milk. Tomatoes and parmesan are already marked at home, so Noor only needs two things.",
      },
      { kind: "member", name: "Eli", text: "tomatoes are still good" },
      { kind: "member", name: "Noor", text: "two things, easy" },
      {
        capability: "room-memory",
        kind: "eliza",
        text: "Noor has the two-item grocery delta. Eli still has trash bags and the dishwasher, so no one else's load changes.",
      },
      {
        capability: "room-memory",
        kind: "card",
        card: {
          capability: "room-memory",
          label: "Tonight's split",
          title: "Chores plus dinner",
          rows: [
            "Pasta + oat milk · Noor",
            "Trash bags + dishwasher · Eli",
            "Coffee + laundry · You",
            "Plants · Jules",
          ],
          source: { kind: "memory", label: "Household memory · room only" },
          status: "Saved list + home inventory reused",
        },
      },
    ],
  },
  {
    id: "trip",
    label: "Trip",
    roomName: "Trip",
    members: ["Theo", "Emi", "Samira"],
    steps: [
      { kind: "member", name: "Theo", text: "airport meetup still good?" },
      { kind: "member", name: "Emi", text: "count me in" },
      { kind: "user", text: "airport plan works for me" },
      { kind: "member", name: "Samira", text: "I arrive the night before" },
      {
        capability: "connected-calendar",
        kind: "eliza",
        text: "I matched the travel calendars: Theo lands at 9:40, Emi at 10:15, you overlap at 10:20, and Samira arrives the night before.",
      },
      {
        capability: "connected-calendar",
        kind: "card",
        card: {
          capability: "connected-calendar",
          label: "Travel calendar match",
          title: "10:20 airport meetup",
          rows: [
            "Samira · Night before",
            "Theo · 9:40",
            "Emi · 10:15",
            "Group overlap · 10:20",
          ],
          source: { kind: "calendar", label: "4 travel calendars shared" },
          status: "Best overlap found",
        },
      },
      { kind: "member", name: "Theo", text: "perfect, meet by arrivals" },
      { kind: "member", name: "Emi", text: "look for my giant red suitcase" },
      { kind: "user", text: "then straight to the apartment?" },
      { kind: "member", name: "Samira", text: "yep, I have the keys" },
      {
        capability: "conversation-memory",
        kind: "eliza",
        text: "Meet by arrivals after Emi lands, find the red suitcase, then head to the apartment. Samira has the keys.",
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
            "Apartment keys · Samira",
          ],
          status: "Updated from this group",
        },
      },
      { kind: "member", name: "Theo", text: "what if Emi's flight is late?" },
      {
        kind: "member",
        name: "Emi",
        text: "wait 30, then go ahead without me",
      },
      {
        capability: "conversation-memory",
        kind: "eliza",
        text: "If Emi isn't out by 10:45, Theo and you head to the apartment. Samira has the keys, and Emi can follow.",
      },
      {
        capability: "conversation-memory",
        kind: "card",
        card: {
          capability: "conversation-memory",
          label: "Delay plan",
          title: "10:45 cutoff",
          rows: [
            "Theo + you · Go ahead",
            "Samira · Has the keys",
            "Emi · Follows after landing",
          ],
          status: "Updated from this group",
        },
      },
      {
        kind: "member",
        name: "Samira",
        text: "the apartment isn't ready until 3",
      },
      { kind: "user", text: "we need somewhere for bags until 3" },
      {
        kind: "member",
        name: "Theo",
        text: "near the apartment would be ideal",
      },
      {
        capability: "public-web-search",
        kind: "eliza",
        text: "Current public listings show the airport train running normally and a staffed bag desk two blocks from the apartment, open until 9. Rain starts around 2, so the covered route wins.",
      },
      { kind: "member", name: "Emi", text: "vegetarian lunch nearby please" },
      { kind: "member", name: "Samira", text: "nothing chosen yet" },
      {
        capability: "public-web-search",
        kind: "eliza",
        text: "I found three vegetarian-friendly lunch options within a five-minute covered walk. The meetup, delay cutoff, keys, bag stop, weather, and lunch filter are handled.",
      },
      {
        capability: "public-web-search",
        kind: "card",
        card: {
          capability: "public-web-search",
          label: "Arrival day",
          title: "Covered until 3 PM",
          rows: [
            "10:45 · Airport cutoff",
            "Bags · Staffed desk nearby",
            "Transit · Covered route before rain",
            "Lunch · 3 vegetarian-friendly options",
            "3 PM · Apartment ready",
          ],
          source: { kind: "web", label: "Public web · checked now" },
          status: "Choose a lunch spot",
          statusKind: "open",
        },
      },
    ],
  },
  {
    id: "community",
    label: "Community",
    roomName: "Community",
    members: ["Rosa", "Dev", "Tasha"],
    steps: [
      { kind: "member", name: "Rosa", text: "I can water Tuesday" },
      { kind: "member", name: "Dev", text: "Thursday works for me" },
      { kind: "user", text: "I'll do Saturday" },
      { kind: "member", name: "Tasha", text: "north bed still needs someone" },
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
          rows: ["Tue · Rosa", "Thu · Dev", "Sat · You", "North bed · Open"],
          status: "Waiting on the group",
          statusKind: "open",
        },
      },
      { kind: "member", name: "Rosa", text: "I can cover that Tuesday too" },
      { kind: "member", name: "Tasha", text: "I'll bring the extra hose" },
      {
        kind: "member",
        name: "Dev",
        text: "seedlings need shade cloth Thursday",
      },
      { kind: "user", text: "I can drop it off Wednesday" },
      {
        capability: "conversation-memory",
        kind: "eliza",
        text: "The full week is covered. Rosa has the north bed, Tasha has the hose, and you'll drop off shade cloth Wednesday.",
      },
      {
        capability: "conversation-memory",
        kind: "card",
        card: {
          capability: "conversation-memory",
          label: "Fewest trips",
          title: "Coverage set",
          rows: [
            "Tue · Rosa + north bed",
            "Wed · Shade cloth from you",
            "Thu · Dev",
            "Sat · You",
          ],
          status: "Updated from this group",
        },
      },
      { kind: "member", name: "Dev", text: "west bed looks dry too" },
      {
        capability: "conversation-memory",
        kind: "eliza",
        text: "You're already there Saturday. Can you add the west bed so Rosa doesn't need a second trip?",
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
            "Rosa avoids a second trip",
            "Rest of week covered",
          ],
          status: "Updated from this group",
        },
      },
      { kind: "member", name: "Tasha", text: "Sunday is supposed to get hot" },
      {
        kind: "member",
        name: "Dev",
        text: "then the seedlings need an extra soak Saturday",
      },
      {
        kind: "user",
        text: "I can do that; Saturday mornings are when I forget",
      },
      {
        capability: "scheduled-reminder",
        kind: "eliza",
        text: "Saturday now covers the west bed and an extra seedling soak. Your usual Saturday reminder now includes both.",
      },
      {
        kind: "member",
        name: "Rosa",
        text: "I'll check the north bed mulch Tuesday",
      },
      {
        kind: "member",
        name: "Tasha",
        text: "I'll leave the hose by the gate",
      },
      {
        capability: "scheduled-reminder",
        kind: "eliza",
        text: "Saturday's reminder now starts with the heat-sensitive seedlings, then the west bed. Rosa checks mulch Tuesday; Tasha stages the hose.",
      },
      {
        capability: "scheduled-reminder",
        kind: "card",
        card: {
          capability: "scheduled-reminder",
          label: "Heat prep",
          title: "No extra garden trip",
          rows: [
            "Tue · Rosa checks mulch",
            "Hose · Tasha leaves it at gate",
            "Sat · West bed + seedlings",
            "Owner Saturday · You",
          ],
          source: {
            kind: "reminder",
            label: "Your reminders · already allowed",
          },
          status: "Saturday reminder set",
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
    step.card.source?.label ?? "",
  ].join(" ");
}
