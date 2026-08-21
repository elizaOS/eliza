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
  steps: readonly LandingDemoStep[];
}

/**
 * Five finite rooms show the same social-agent skill in situations people
 * recognize. Each recap is derived only from messages already visible in that
 * room; changing rooms never implies memory leaking between conversations.
 */
const LANDING_DEMO_SCENARIO_DEFINITIONS: readonly LandingDemoScenario[] = [
  {
    id: "friends",
    label: "Friends",
    roomName: "Friends",
    members: ["Maya", "Leo", "Priya", "Jamie"],
    steps: [
      { kind: "member", name: "Maya", text: "dinner this weekend?" },
      { kind: "user", text: "I'm in" },
      { kind: "member", name: "Leo", text: "same" },
      { kind: "member", name: "Priya", text: "somewhere quiet pls" },
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
      { kind: "user", text: "ok perfect" },
      { kind: "member", name: "Maya", text: "outside if it's nice?" },
      { kind: "member", name: "Leo", text: "mission or noe?" },
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
        text: "has to have veggie stuff for me lol",
      },
      { kind: "member", name: "Jamie", text: "honestly just pick somewhere" },
      {
        capability: "room-memory",
        kind: "eliza",
        text: "I already filtered for Priya being vegetarian and Jamie's severe peanut allergy. Peanut cross-contact is a hard constraint.",
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
            label: "Remembered for Friends",
          },
          status: "Filtering risky matches",
          statusKind: "open",
        },
      },
      { kind: "member", name: "Maya", text: "noe pls" },
      { kind: "member", name: "Leo", text: "just not somewhere loud" },
      {
        capability: "public-web-search",
        kind: "eliza",
        text: "I found Cypress Table in Noe and checked its current allergy policy. It has vegetarian mains, a quiet patio, and a separate prep protocol for peanut allergies.",
      },
      { kind: "member", name: "Priya", text: "looks good" },
      {
        kind: "member",
        name: "Jamie",
        text: "wait so I can actually eat there?",
      },
      { kind: "user", text: "yeah we can eat inside idc" },
      {
        capability: "public-web-search",
        kind: "eliza",
        text: "Their published protocol covers Jamie's peanut constraint, including separate tools and a manager check at the table. Cypress Table is the best fit, and I kept a second verified option as backup.",
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
            "Peanut protocol checked for Jamie",
            "Verified backup ready",
          ],
          source: { kind: "web", label: "Public web · checked now" },
          status: "Best match found",
          statusKind: "confirmed",
        },
      },
    ],
  },
  {
    id: "co-parenting",
    label: "Co-parenting",
    roomName: "Co-parenting",
    members: ["Nina"],
    steps: [
      {
        kind: "member",
        name: "Nina",
        text: "you still getting her thursday at 5?",
      },
      { kind: "user", text: "yeah. I can do friday too" },
      {
        kind: "member",
        name: "Nina",
        text: "ok her blue bag is packed",
      },
      { kind: "user", text: "wait who has soccer saturday" },
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
        text: "fine I'll do soccer",
      },
      { kind: "user", text: "ok I'll bring her cleats friday" },
      {
        kind: "member",
        name: "Nina",
        text: "permission slip is in the side pocket",
      },
      {
        kind: "user",
        text: "k",
      },
      {
        capability: "conversation-memory",
        kind: "eliza",
        text: "Pickups and soccer are covered. Backpack, cleats, and permission slip are accounted for. No direct negotiation required.",
      },
      {
        capability: "room-memory",
        kind: "card",
        card: {
          capability: "room-memory",
          label: "Treaty status",
          title: "Everyone knows their job",
          rows: [
            "Thu pickup · Nina",
            "Fri pickup + cleats · You",
            "Sat soccer · Nina",
            "Backpack is ready",
          ],
          source: {
            kind: "memory",
            label: "Remembered for Co-parenting",
          },
          status: "Zero extra replies needed",
        },
      },
      {
        kind: "member",
        name: "Nina",
        text: "work might run late thursday",
      },
      { kind: "user", text: "I can get her if you're not there by 5:30" },
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
      { kind: "member", name: "Nina", text: "I have her inhaler btw" },
      {
        kind: "user",
        text: "is it in the front pocket",
      },
      {
        capability: "room-memory",
        kind: "eliza",
        text: "Yep, front pocket of the blue backpack. That's where Ava's inhaler stays.",
      },
      { kind: "member", name: "Nina", text: "good" },
      { kind: "user", text: "cool thanks" },
      {
        kind: "member",
        name: "Nina",
        text: "I'm just leaving the cleats in the car from now on lol",
      },
      {
        capability: "scheduled-reminder",
        kind: "eliza",
        text: "I added the inhaler check to Friday's existing 4:30 handoff reminder. You both have the same plan, so nobody needs another text.",
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
      { kind: "user", text: "and oat milk" },
      { kind: "member", name: "Eli", text: "I took recycling out" },
      {
        kind: "member",
        name: "Jules",
        text: "laundry got left in the washer again lol",
      },
      {
        capability: "room-memory",
        kind: "eliza",
        text: "I balanced this against the house rotation: coffee and laundry are yours, Noor has the dishwasher, Eli's recycling counts, and Jules has the plants.",
      },
      {
        capability: "room-memory",
        kind: "card",
        card: {
          capability: "room-memory",
          label: "Fair rotation",
          title: "Tonight is split evenly",
          rows: [
            "Coffee + laundry · You",
            "Dishwasher · Noor",
            "Recycling · Eli",
            "Plants · Jules",
          ],
          source: { kind: "memory", label: "Household memory · room only" },
          status: "Balanced from the house rotation",
          statusKind: "confirmed",
        },
      },
      { kind: "user", text: "ugh ok lol" },
      { kind: "member", name: "Noor", text: "dishwasher is clean btw" },
      { kind: "member", name: "Eli", text: "I'm home late" },
      { kind: "member", name: "Jules", text: "plants are done" },
      {
        capability: "conversation-memory",
        kind: "eliza",
        text: "Noor unloads the dishwasher. Eli already covered recycling, Jules finished the plants, and you have coffee plus laundry. No swap is needed.",
      },
      {
        capability: "conversation-memory",
        kind: "card",
        card: {
          capability: "conversation-memory",
          label: "Chore balance",
          title: "Everyone has a lane",
          rows: [
            "Coffee + laundry · You",
            "Dishwasher · Noor",
            "Recycling · Eli",
            "Plants · Jules",
          ],
          status: "Adjusted around Eli getting home late",
        },
      },
      {
        kind: "member",
        name: "Noor",
        text: "also we're basically out of trash bags",
      },
      {
        capability: "conversation-memory",
        kind: "eliza",
        text: "Trash bags go to Eli's next store run. That gives him a second task and keeps anyone else from getting a third.",
      },
      { kind: "member", name: "Eli", text: "fine" },
      {
        capability: "conversation-memory",
        kind: "card",
        card: {
          capability: "conversation-memory",
          label: "Fair split",
          title: "No one gets everything",
          rows: [
            "Coffee + laundry · You",
            "Dishwasher · Noor",
            "Recycling + trash bags · Eli",
            "Plants · Jules",
          ],
          status: "Two tasks max so far",
        },
      },
      {
        kind: "member",
        name: "Jules",
        text: "do we have anything for dinner",
      },
      {
        kind: "member",
        name: "Noor",
        text: "please don't make me do a huge grocery run",
      },
      { kind: "user", text: "pasta?" },
      {
        capability: "room-memory",
        kind: "eliza",
        text: "No huge run. Noor gets pasta and oat milk, just two things. Tomatoes and parmesan are already at home. Jules cooks, which brings everyone to two tasks.",
      },
      { kind: "member", name: "Eli", text: "wait we still have tomatoes" },
      { kind: "member", name: "Jules", text: "ok pasta is easy" },
      {
        capability: "room-memory",
        kind: "eliza",
        text: "Yep, tomatoes were already counted. Final split: Noor shops, Jules cooks, Eli gets trash bags, and you handle coffee plus laundry.",
      },
      {
        capability: "room-memory",
        kind: "card",
        card: {
          capability: "room-memory",
          label: "Tonight's split",
          title: "Chores plus dinner",
          rows: [
            "Dishwasher + 2-item run · Noor",
            "Plants + pasta · Jules",
            "Recycling + trash bags · Eli",
            "Coffee + laundry · You",
          ],
          source: { kind: "memory", label: "Household memory · room only" },
          status: "Two tasks each",
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
      {
        kind: "member",
        name: "Theo",
        text: "are we meeting at the airport or what",
      },
      { kind: "member", name: "Emi", text: "yeah I'm down" },
      { kind: "user", text: "works for me" },
      { kind: "member", name: "Samira", text: "I'm there the night before" },
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
      { kind: "member", name: "Theo", text: "ok arrivals then" },
      {
        kind: "member",
        name: "Emi",
        text: "I'll have the huge red suitcase lol",
      },
      { kind: "user", text: "then we just go to the apartment?" },
      { kind: "member", name: "Samira", text: "yeah I have the keys" },
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
      { kind: "member", name: "Theo", text: "what if emi's late tho" },
      {
        kind: "member",
        name: "Emi",
        text: "wait like 30 min then leave me lol",
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
        text: "oh wait we can't get in til 3",
      },
      { kind: "user", text: "ok where do we put all our stuff" },
      {
        kind: "member",
        name: "Theo",
        text: "somewhere near the apartment pls",
      },
      {
        capability: "public-web-search",
        kind: "eliza",
        text: "Current public listings show the airport train running normally and a staffed bag desk two blocks from the apartment, open until 9. Rain starts around 2, so the covered route wins.",
      },
      {
        kind: "member",
        name: "Emi",
        text: "and food pls I need veggie options",
      },
      { kind: "member", name: "Samira", text: "I'm starving lol" },
      {
        capability: "public-web-search",
        kind: "eliza",
        text: "I found three full-menu lunch spots within a five-minute covered walk. All have real vegetarian options for Emi and plenty of meat for Theo. The rest of the arrival plan still holds.",
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
            "Lunch · Veg for Emi + meat for Theo",
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
      { kind: "member", name: "Rosa", text: "I can water tuesday" },
      { kind: "member", name: "Dev", text: "I can do thursday" },
      { kind: "user", text: "I'll take saturday" },
      { kind: "member", name: "Tasha", text: "wait who's doing the north bed" },
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
      { kind: "member", name: "Rosa", text: "I can do that tuesday too" },
      { kind: "member", name: "Tasha", text: "I'll bring the other hose" },
      {
        kind: "member",
        name: "Dev",
        text: "the seedlings need that shade thing thursday",
      },
      { kind: "user", text: "I can drop it there wednesday" },
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
      { kind: "member", name: "Dev", text: "west bed looks super dry too" },
      {
        capability: "conversation-memory",
        kind: "eliza",
        text: "You're already there Saturday. Can you add the west bed so Rosa doesn't need a second trip?",
      },
      { kind: "user", text: "yeah sure I'll do both" },
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
      {
        kind: "member",
        name: "Tasha",
        text: "isn't it gonna be really hot sunday",
      },
      {
        kind: "member",
        name: "Dev",
        text: "oh then the seedlings need more water saturday",
      },
      {
        kind: "user",
        text: "ok remind me tho I always forget saturday stuff",
      },
      {
        capability: "scheduled-reminder",
        kind: "eliza",
        text: "Saturday now covers the west bed and an extra seedling soak. Your usual Saturday reminder now includes both.",
      },
      {
        kind: "member",
        name: "Rosa",
        text: "I'll check the mulch tuesday too",
      },
      {
        kind: "member",
        name: "Tasha",
        text: "I'll put the hose by the gate",
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

const LANDING_DEMO_SCENARIO_ORDER: readonly LandingDemoScenarioId[] = [
  "household",
  "co-parenting",
  "friends",
  "trip",
  "community",
];

export const LANDING_DEMO_SCENARIOS: readonly LandingDemoScenario[] =
  LANDING_DEMO_SCENARIO_ORDER.map((id) => {
    const scenario = LANDING_DEMO_SCENARIO_DEFINITIONS.find(
      (candidate) => candidate.id === id,
    );
    if (!scenario) throw new Error(`Missing landing demo scenario: ${id}`);
    return scenario;
  });

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
