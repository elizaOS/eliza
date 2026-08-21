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
 * matching capability. Attachments use that same capability contract, which
 * the contract test enforces.
 */
export function findUndeclaredLandingDemoClaims(
  step: LandingDemoStep,
): LandingDemoUnsupportedClaimCategory[] {
  const detected = findUnsupportedLandingDemoClaims(landingDemoStepText(step));
  if (step.kind === "member" || step.kind === "user") return [];
  const allowed = ALLOWED_CLAIMS_BY_CAPABILITY[step.capability];
  return detected.filter((category) => !allowed.includes(category));
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
      capability: "public-web-search";
      kind: "place";
      place: LandingDemoPlace;
    }
  | {
      capability: "room-memory";
      kind: "task-list";
      taskList: LandingDemoTaskList;
    }
  | {
      capability: "scheduled-reminder";
      handoff: LandingDemoHandoff;
      kind: "handoff";
    }
  | {
      capability: "public-web-search";
      itinerary: LandingDemoItinerary;
      kind: "itinerary";
    }
  | {
      capability: "scheduled-reminder";
      heatPlan: LandingDemoHeatPlan;
      kind: "heat-plan";
    };

export interface LandingDemoPlace {
  category: string;
  distance: string;
  feature: string;
  name: string;
  neighborhood: string;
  rating: string;
}

export interface LandingDemoTaskList {
  items: readonly {
    assignee: string;
    completed: boolean;
    task: string;
  }[];
  title: string;
}

export interface LandingDemoHandoff {
  child: string;
  day: string;
  location: string;
  time: string;
  title: string;
}

export interface LandingDemoItinerary {
  stops: readonly {
    label: string;
    time: string;
  }[];
  title: string;
}

export interface LandingDemoHeatPlan {
  schedule: readonly {
    assignee: string;
    day: string;
    task: string;
  }[];
  title: string;
}

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
        text: "Saturday after 7 is the only time the four shared calendars overlap. Jamie still needs to answer.",
      },
      { kind: "member", name: "Jamie", text: "7:30 works" },
      { kind: "user", text: "ok perfect" },
      { kind: "member", name: "Maya", text: "outside if it's nice?" },
      { kind: "member", name: "Leo", text: "mission or noe?" },
      {
        capability: "conversation-memory",
        kind: "eliza",
        text: "7:30 works for everyone. I'll keep it quiet, with outdoor seating if it's warm. Mission or Noe both work.",
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
        text: "Already on it. I remembered Priya is vegetarian and Jamie has a severe peanut allergy, so I'm only checking places with a real cross-contact protocol.",
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
        text: "Yes. Their current policy uses separate tools and a manager check at the table. Cypress Table is the best fit: quiet patio, indoor backup, good vegetarian mains, and a peanut protocol. I saved a verified backup too.",
      },
      {
        capability: "public-web-search",
        kind: "place",
        place: {
          category: "Italian",
          distance: "0.4 mi",
          feature: "Quiet patio",
          name: "Cypress Table",
          neighborhood: "Noe Valley",
          rating: "4.8",
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
        text: "Ava's family calendar has soccer Saturday at 9. Nina has Thursday pickup, you have Friday, and soccer still needs one of you.",
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
        text: "Done. Nina has Thursday pickup and Saturday soccer. You have Friday pickup and the cleats. The backpack and permission slip are ready.",
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
        text: "Nina is still primary Thursday at 5. If she isn't there by 5:30, you take over. Friday and Saturday stay the same.",
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
        text: "I added an inhaler check to Friday's 4:30 handoff reminder. Blue backpack, front pocket. Cleats stay in the car. You both have the same plan now.",
      },
      {
        capability: "scheduled-reminder",
        kind: "handoff",
        handoff: {
          child: "Ava",
          day: "Friday",
          time: "4:30 PM",
          title: "Soccer",
          location: "Mission Rec Field",
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
        text: "I checked the house rotation. You have coffee and laundry, Noor has the dishwasher, Eli's recycling counts, and Jules has the plants. That's even.",
      },
      { kind: "user", text: "ugh ok lol" },
      { kind: "member", name: "Noor", text: "dishwasher is clean btw" },
      { kind: "member", name: "Eli", text: "I'm home late" },
      { kind: "member", name: "Jules", text: "plants are done" },
      {
        capability: "conversation-memory",
        kind: "eliza",
        text: "No swap needed. Noor unloads the dishwasher, Eli already did recycling, Jules finished the plants, and you still have coffee plus laundry.",
      },
      {
        kind: "member",
        name: "Noor",
        text: "also we're basically out of trash bags",
      },
      {
        capability: "conversation-memory",
        kind: "eliza",
        text: "Trash bags go on Eli's next store run. That gives him two jobs and keeps anyone else from getting stuck with a third.",
      },
      { kind: "member", name: "Eli", text: "fine" },
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
        text: "No huge run. Noor only needs pasta and oat milk. You already have tomatoes and parmesan, and Jules can cook. That puts everyone at two jobs.",
      },
      { kind: "member", name: "Eli", text: "wait we still have tomatoes" },
      { kind: "member", name: "Jules", text: "ok pasta is easy" },
      {
        capability: "room-memory",
        kind: "eliza",
        text: "Yep. Final split: Noor does the dishwasher and two-item run, Jules has plants and pasta, Eli has recycling and trash bags, and you have coffee and laundry. Two each.",
      },
      {
        capability: "room-memory",
        kind: "task-list",
        taskList: {
          title: "To Do List",
          items: [
            { assignee: "You", completed: false, task: "Coffee + laundry" },
            {
              assignee: "Noor",
              completed: false,
              task: "Dishwasher + 2-item run",
            },
            { assignee: "Eli", completed: true, task: "Recycling" },
            { assignee: "Eli", completed: false, task: "Trash bags" },
            { assignee: "Jules", completed: true, task: "Plants" },
            { assignee: "Jules", completed: false, task: "Pasta" },
          ],
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
        text: "I matched all four travel calendars. Theo lands at 9:40, Emi at 10:15, and you three overlap at arrivals at 10:20. Samira is already there from the night before.",
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
        text: "Meet at arrivals at 10:20. If you spot the giant red suitcase, you found Emi. Then head over together.",
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
        text: "Give Emi until 10:45. If she isn't out, you and Theo can leave and she'll catch up.",
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
        text: "There's a staffed bag drop two blocks from the apartment, and the airport train is running normally. Rain starts around 2, so take the covered route.",
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
        text: "Lunch is on the covered walk by the bag drop. I picked a place with solid veggie food for Emi and burgers for Theo. Bags first, lunch after, apartment at 3.",
      },
      {
        capability: "public-web-search",
        kind: "itinerary",
        itinerary: {
          title: "Arrival Plan",
          stops: [
            {
              time: "10:20",
              label: "Meet at arrivals",
            },
            {
              time: "Next",
              label: "Drop bags",
            },
            {
              time: "Then",
              label: "Get lunch",
            },
            {
              time: "3:00",
              label: "Apartment",
            },
          ],
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
        text: "Tuesday is Rosa, Thursday is Dev, and Saturday is you. The north bed is the only thing still uncovered.",
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
        text: "Full week is covered now. Rosa adds the north bed Tuesday, you drop the shade cloth Wednesday, Dev waters Thursday, and Tasha leaves the hose ready for Saturday.",
      },
      { kind: "member", name: "Dev", text: "west bed looks super dry too" },
      {
        capability: "conversation-memory",
        kind: "eliza",
        text: "You're already there Saturday, so adding the west bed to your round saves Rosa a second trip. Can you take it?",
      },
      { kind: "user", text: "yeah sure I'll do both" },
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
        text: "Your Saturday reminder now starts with the heat-sensitive seedlings, then the west bed. Rosa checks mulch Tuesday, and Tasha leaves the hose at the gate. No extra garden trip needed.",
      },
      {
        capability: "scheduled-reminder",
        kind: "heat-plan",
        heatPlan: {
          title: "Friday Weather",
          schedule: [
            { day: "SAT", task: "Water seedlings", assignee: "You" },
            { day: "SAT", task: "Water west bed", assignee: "You" },
            { day: "TUE", task: "Check mulch", assignee: "Rosa" },
            { day: "SAT", task: "Hose by gate", assignee: "Tasha" },
          ],
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
  if (step.kind === "place") {
    return [
      step.place.name,
      step.place.category,
      step.place.neighborhood,
      step.place.distance,
      step.place.rating,
      step.place.feature,
    ].join(" ");
  }
  if (step.kind === "task-list") {
    return [
      step.taskList.title,
      ...step.taskList.items.flatMap((item) => [item.assignee, item.task]),
    ].join(" ");
  }
  if (step.kind === "handoff") {
    return [
      step.handoff.child,
      step.handoff.title,
      step.handoff.day,
      step.handoff.time,
      step.handoff.location,
    ].join(" ");
  }
  if (step.kind === "itinerary") {
    return [
      step.itinerary.title,
      ...step.itinerary.stops.flatMap((stop) => [stop.time, stop.label]),
    ].join(" ");
  }
  if (step.kind === "heat-plan") {
    return [
      step.heatPlan.title,
      ...step.heatPlan.schedule.flatMap((item) => [
        item.day,
        item.task,
        item.assignee,
      ]),
    ].join(" ");
  }
  return step.text;
}
