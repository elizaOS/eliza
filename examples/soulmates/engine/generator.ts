import type {
  AppearanceProfile,
  AttractivenessAssessment,
  Availability,
  AvailabilityWindow,
  Conversation,
  ConversationRole,
  DatingProfile,
  DomainMode,
  EngineState,
  Fact,
  FactStatus,
  FeedbackEntry,
  FeedbackIssue,
  FeedbackIssueSeverity,
  FeedbackSentiment,
  FriendshipProfile,
  GeneralProfile,
  MatchGraph,
  Persona,
  PersonaId,
  ProfileCore,
  ReliabilitySignals,
} from "./types";
import { clampInt, clampNumber, createRng, isoNow, unique } from "./utils";

export interface PersonaGenerationOptions {
  seed: number;
  count: number;
  now?: string;
}

export interface EngineSeedOptions {
  seed: number;
  personaCount: number;
  feedbackEvents: number;
  now?: string;
}

const NAMES = [
  "Avery",
  "Jordan",
  "Riley",
  "Kai",
  "Morgan",
  "Taylor",
  "Quinn",
  "Aria",
  "Noah",
  "Maya",
  "Eli",
  "Sasha",
  "Leah",
  "Omar",
  "Nina",
  "Leo",
  "Ivy",
  "Zane",
  "Lia",
  "Sam",
  "Zoey",
  "Drew",
  "Isla",
  "Miles",
  "Jules",
];

const GENDER_OPTIONS = [
  { value: "woman", weight: 0.44 },
  { value: "man", weight: 0.44 },
  { value: "nonbinary", weight: 0.05 },
  { value: "genderqueer", weight: 0.03 },
  { value: "trans woman", weight: 0.02 },
  { value: "trans man", weight: 0.02 },
];
const PRONOUNS = ["she/her", "he/him", "they/them", "she/they", "he/they"];

const VALUES = [
  "curiosity",
  "ambition",
  "empathy",
  "honesty",
  "adventure",
  "stability",
  "learning",
  "creativity",
  "community",
  "discipline",
  "health",
  "growth",
  "service",
  "playfulness",
];

const INTERESTS = [
  "music",
  "design",
  "film",
  "hiking",
  "food",
  "reading",
  "fitness",
  "startups",
  "art",
  "travel",
  "gaming",
  "photography",
  "volunteering",
  "coding",
  "fashion",
  "yoga",
  "coffee",
  "board games",
  "science",
  "writing",
  "basketball",
  "soccer",
  "baking",
  "gardening",
  "meditation",
];

const BUSINESS_ROLES = [
  "technical",
  "product",
  "design",
  "growth",
  "sales",
  "operations",
];
const INDUSTRIES = [
  "health",
  "fintech",
  "education",
  "climate",
  "consumer",
  "ai",
  "media",
];
const COMPANY_STAGES = ["idea", "prototype", "early", "growth"];
const COMMITMENT_LEVELS = ["full_time", "part_time", "exploring"];

const FRIENDSHIP_VIBES = [
  "chill",
  "curious",
  "adventurous",
  "grounded",
  "playful",
];
const FRIENDSHIP_ENERGY = ["low_key", "balanced", "high_energy"];
const FRIENDSHIP_BOUNDARIES = [
  "quiet_time",
  "no_alcohol",
  "early_mornings",
  "flexible_plans",
];

const RELATIONSHIP_GOALS = [
  "long_term",
  "serious_but_slow",
  "exploring",
  "casual",
];
const LIFESTYLES = [
  "early_gym",
  "late_night",
  "balanced",
  "homebody",
  "social_foodie",
];
const COMMUNICATION_STYLES = ["direct", "warm", "low_texting", "high_texting"];
const BUILDS: AppearanceProfile["build"][] = [
  "thin",
  "fit",
  "average",
  "above_average",
  "overweight",
];
const ETHNICITIES = [
  { value: "white", weight: 0.35 },
  { value: "black", weight: 0.16 },
  { value: "asian", weight: 0.2 },
  { value: "latinx", weight: 0.16 },
  { value: "middle eastern", weight: 0.05 },
  { value: "mixed", weight: 0.08 },
];

const ORIENTATIONS = [
  { value: "straight", weight: 0.62 },
  { value: "bisexual", weight: 0.18 },
  { value: "gay", weight: 0.12 },
  { value: "pansexual", weight: 0.06 },
  { value: "asexual", weight: 0.02 },
];

const CITY_OPTIONS = [
  {
    city: "San Francisco",
    country: "USA",
    timeZone: "America/Los_Angeles",
    geo: { lat: 37.7749, lng: -122.4194 },
    neighborhoods: ["Mission", "SoMa", "Sunset", "Nob Hill", "Richmond"],
  },
  {
    city: "New York",
    country: "USA",
    timeZone: "America/New_York",
    geo: { lat: 40.7128, lng: -74.006 },
    neighborhoods: [
      "Brooklyn",
      "Queens",
      "Manhattan",
      "Harlem",
      "Williamsburg",
    ],
  },
];

const sampleList = (
  rng: ReturnType<typeof createRng>,
  source: string[],
  min: number,
  max: number,
): string[] => {
  const count = clampInt(rng.int(min, max), min, Math.min(max, source.length));
  const shuffled = rng.shuffle(source);
  return shuffled.slice(0, count);
};

const genderCategory = (value: string): "woman" | "man" | "nonbinary" => {
  const normalized = value.toLowerCase();
  if (normalized.includes("woman")) {
    return "woman";
  }
  if (normalized.includes("man")) {
    return "man";
  }
  return "nonbinary";
};

const derivePreferredGenders = (
  orientation: string,
  genderIdentity: string,
): string[] => {
  const orientationLower = orientation.toLowerCase();
  const selfGender = genderCategory(genderIdentity);
  if (orientationLower.includes("bi") || orientationLower.includes("pan")) {
    return ["woman", "man", "nonbinary"];
  }
  if (orientationLower.includes("gay")) {
    return [selfGender];
  }
  if (orientationLower.includes("straight")) {
    if (selfGender === "man") {
      return ["woman"];
    }
    if (selfGender === "woman") {
      return ["man"];
    }
    return ["woman", "man"];
  }
  return ["woman", "man", "nonbinary"];
};

const randomAvailability = (
  rng: ReturnType<typeof createRng>,
  timeZone: string,
): Availability => {
  const windows: AvailabilityWindow[] = [];
  const days: AvailabilityWindow["day"][] = [
    "mon",
    "tue",
    "wed",
    "thu",
    "fri",
    "sat",
    "sun",
  ];
  const windowCount = rng.int(3, 6);
  for (let i = 0; i < windowCount; i += 1) {
    const day = rng.pick(days);
    const start = rng.int(8, 19) * 60;
    const end = start + rng.int(90, 180);
    windows.push({ day, startMinutes: start, endMinutes: end });
  }
  return { timeZone, weekly: windows, exceptions: [] };
};

const randomReliability = (
  rng: ReturnType<typeof createRng>,
  now: string,
): ReliabilitySignals => {
  const score = clampNumber(rng.next() ** 0.4, 0, 1);
  return {
    score,
    lastUpdated: now,
    attendedCount: rng.int(0, 12),
    lateCancelCount: rng.int(0, 4),
    noShowCount: rng.int(0, 3),
    ghostCount: rng.int(0, 2),
    ghostedByOthersCount: rng.int(0, 3),
    canceledOnByOthersCount: rng.int(0, 4),
    responseLatencyAvgMinutes: rng.int(5, 240),
    history: [],
  };
};

const randomAppearance = (
  rng: ReturnType<typeof createRng>,
): AppearanceProfile => {
  const attractiveness = clampInt(1 + rng.next() ** 0.7 * 9, 1, 10);
  return {
    attractiveness,
    build: rng.pick(BUILDS),
    hairColor: rng.pick(["black", "brown", "blonde", "red", "gray", "auburn"]),
    eyeColor: rng.pick(["brown", "blue", "green", "hazel", "gray"]),
    skinTone: clampInt(1 + rng.next() * 9, 1, 10),
    ethnicity: rng.pickWeighted(
      ETHNICITIES.map((item) => ({ item: item.value, weight: item.weight })),
    ),
    perceivedGender: clampInt(1 + rng.next() * 9, 1, 10),
    distinctiveFeatures: sampleList(
      rng,
      ["tattoos", "glasses", "piercings", "freckles", "beard", "dimples"],
      0,
      2,
    ),
  };
};

const buildAttractivenessAssessment = (
  rng: ReturnType<typeof createRng>,
  appearance: AppearanceProfile,
  now: string,
): AttractivenessAssessment => {
  const score = clampInt(appearance.attractiveness + rng.int(-2, 2), 1, 10);
  return {
    assessmentId: `att-${rng.int(1000, 9999)}`,
    modelScore: score,
    eloRating: clampInt(
      900 + appearance.attractiveness * 80 + rng.int(-120, 120),
      700,
      1700,
    ),
    notes: sampleList(
      rng,
      ["photogenic", "authentic", "stylish", "approachable", "bold"],
      0,
      2,
    ),
    assessedAt: now,
  };
};

const randomDatingProfile = (
  rng: ReturnType<typeof createRng>,
  now: string,
  general: GeneralProfile,
): DatingProfile => {
  const appearance = randomAppearance(rng);
  const orientation = rng.pickWeighted(
    ORIENTATIONS.map((item) => ({ item: item.value, weight: item.weight })),
  );
  const relationshipGoal = rng.pick(RELATIONSHIP_GOALS);
  const preferredAgeMin = rng.int(20, 40);
  const preferredAgeMax = rng.int(
    Math.min(preferredAgeMin + 4, 50),
    Math.min(preferredAgeMin + 18, 60),
  );
  const derivedPreferred = derivePreferredGenders(
    orientation,
    general.genderIdentity,
  );
  return {
    datingPreferences: {
      preferredGenders: rng.bool(0.2) ? [] : derivedPreferred,
      preferredAgeMin,
      preferredAgeMax,
      relationshipGoal,
      dealbreakers: sampleList(
        rng,
        ["smoking", "not reliable", "no ambition", "not communicative", "rude"],
        0,
        2,
      ),
      bodyTypePreferences: rng.bool(0.6) ? sampleList(rng, BUILDS, 1, 3) : [],
      attractivenessImportance: rng.int(3, 10),
      fitnessImportance: rng.int(3, 10),
      orientation,
    },
    attractionProfile: {
      appearance,
      assessments: [buildAttractivenessAssessment(rng, appearance, now)],
    },
    hobbies: sampleList(rng, INTERESTS, 3, 6),
    personalityTraits: sampleList(
      rng,
      [
        "thoughtful",
        "bold",
        "laid-back",
        "driven",
        "optimistic",
        "grounded",
        "witty",
      ],
      2,
      4,
    ),
    communicationStyle: rng.pick(COMMUNICATION_STYLES),
    lifestyle: rng.pick(LIFESTYLES),
    relationshipGoal,
    schedule: rng.pick([
      "early_weekends",
      "evenings",
      "flexible",
      "structured",
    ]),
  };
};

const randomFriendshipProfile = (
  rng: ReturnType<typeof createRng>,
): FriendshipProfile => {
  return {
    vibe: rng.pick(FRIENDSHIP_VIBES),
    energy: rng.pick(FRIENDSHIP_ENERGY),
    socialStyle: rng.pick(["one_on_one", "group", "mixed"]),
    interests: sampleList(rng, INTERESTS, 4, 8),
    hobbies: sampleList(rng, INTERESTS, 3, 6),
    boundaries: sampleList(rng, FRIENDSHIP_BOUNDARIES, 0, 2),
  };
};

const randomBusinessProfile = (
  rng: ReturnType<typeof createRng>,
): Persona["domainProfiles"]["business"] => {
  return {
    jobTitle: rng.pick(["engineer", "designer", "founder", "pm", "marketer"]),
    industry: rng.pick(INDUSTRIES),
    roles: sampleList(rng, BUSINESS_ROLES, 1, 2),
    seekingRoles: sampleList(rng, BUSINESS_ROLES, 1, 2),
    skills: sampleList(
      rng,
      [
        "backend",
        "frontend",
        "ml",
        "sales",
        "growth",
        "design",
        "ops",
        "finance",
      ],
      3,
      6,
    ),
    experienceYears: rng.int(1, 12),
    companyStage: rng.pick(COMPANY_STAGES),
    commitment: rng.pick(COMMITMENT_LEVELS),
    values: sampleList(rng, VALUES, 2, 4),
  };
};

const randomProfileCore = (
  rng: ReturnType<typeof createRng>,
  general: GeneralProfile,
  now: string,
): ProfileCore => {
  return {
    name: general.name,
    pronouns: general.pronouns,
    availability: randomAvailability(rng, general.location.timeZone),
    interests: sampleList(rng, INTERESTS, 4, 8),
    meetingCadence: rng.pick(["weekly", "biweekly", "monthly", "flexible"]),
    connectionGoals: sampleList(
      rng,
      ["growth", "accountability", "inspiration", "belonging"],
      1,
      2,
    ),
    communityTags: sampleList(
      rng,
      ["founders", "artists", "builders", "creators", "wellness"],
      0,
      2,
    ),
    feedbackSummary: {
      sentimentScore: 0,
      positiveCount: 0,
      neutralCount: 0,
      negativeCount: 0,
      lastUpdated: now,
      redFlagTags: [],
      issueTags: [],
    },
  };
};

const randomGeneralProfile = (
  rng: ReturnType<typeof createRng>,
): GeneralProfile => {
  const city = rng.pick(CITY_OPTIONS);
  const name = rng.pick(NAMES);
  return {
    name,
    age: rng.int(18, 55),
    genderIdentity: rng.pickWeighted(
      GENDER_OPTIONS.map((item) => ({ item: item.value, weight: item.weight })),
    ),
    pronouns: rng.pick(PRONOUNS),
    location: {
      city: city.city,
      country: city.country,
      neighborhood: rng.pick(city.neighborhoods),
      timeZone: city.timeZone,
      geo: city.geo,
    },
    values: sampleList(rng, VALUES, 3, 5),
    education: rng.pick([
      "high school",
      "college",
      "masters",
      "phd",
      "bootcamp",
    ]),
    bio: `${name} is focused on ${rng.pick(INTERESTS)} and values ${rng.pick(VALUES)}.`,
  };
};

const generateDomains = (rng: ReturnType<typeof createRng>): DomainMode[] => {
  const domainPool: DomainMode[] = ["friendship", "dating", "business"];
  const base = rng.pickWeighted([
    { item: "friendship" as DomainMode, weight: 0.4 },
    { item: "dating" as DomainMode, weight: 0.35 },
    { item: "business" as DomainMode, weight: 0.25 },
  ]);
  const domains: DomainMode[] = [base];
  if (rng.bool(0.35)) {
    const others = domainPool.filter((d) => d !== base);
    domains.push(rng.pick(others));
  }
  if (rng.bool(0.12)) {
    const remaining = domainPool.filter((d) => !domains.includes(d));
    if (remaining.length > 0) {
      domains.push(rng.pick(remaining));
    }
  }
  return unique(domains);
};

const generateConversation = (
  rng: ReturnType<typeof createRng>,
  personaId: PersonaId,
  idx: number,
  now: string,
): Conversation => {
  const turnCount = rng.int(2, 16);
  const turns = Array.from({ length: turnCount }, (_, turnIdx) => {
    const role: ConversationRole = turnIdx % 2 === 0 ? "agent" : "user";
    return {
      turnId: `p${personaId}-c${idx}-t${turnIdx}`,
      role,
      text:
        role === "agent"
          ? rng.pick([
              "Tell me more about what you want from this connection.",
              "What is a recent highlight from your week?",
              "How do you like to spend your free time?",
              "What is a dealbreaker for you?",
            ])
          : rng.pick([
              "I love thoughtful conversations and trying new places.",
              "Consistency matters a lot to me.",
              "I am excited to meet people who care about growth.",
              "I want someone who respects my time.",
            ]),
      createdAt: now,
    };
  });
  const processed = rng.bool(0.6);
  return {
    conversationId: `p${personaId}-c${idx}`,
    scenario: rng.pick(["onboarding", "check_in", "feedback", "availability"]),
    turns,
    processed,
    processedAt: processed ? now : undefined,
  };
};

const generateFacts = (
  rng: ReturnType<typeof createRng>,
  persona: Persona,
  now: string,
): Fact[] => {
  const baseFacts = [
    {
      type: "interest",
      key: "interests",
      value: persona.profile.interests.slice(0, 3),
    },
    { type: "value", key: "values", value: persona.general.values.slice(0, 3) },
    { type: "goal", key: "goals", value: persona.profile.connectionGoals },
    {
      type: "reliability",
      key: "reliability_score",
      value: persona.reliability.score,
    },
  ];
  const extraFacts = sampleList(
    rng,
    [
      "prefers evenings",
      "likes small groups",
      "seeks accountability",
      "enjoys coffee chats",
    ],
    0,
    2,
  ).map((value, idx) => ({ type: "note", key: `note_${idx}`, value }));

  const facts: Fact[] = [...baseFacts, ...extraFacts].map((fact, idx) => {
    const hasConversation =
      persona.conversations.length > 0 &&
      persona.conversations[0]?.turns.length > 0;
    const status: FactStatus = "active";
    return {
      factId: `fact-${persona.id}-${idx}`,
      type: fact.type,
      key: fact.key,
      value: fact.value,
      confidence: clampNumber(0.7 + rng.next() * 0.3, 0, 1),
      evidence: hasConversation
        ? [
            {
              conversationId: persona.conversations[0].conversationId,
              turnIds: [persona.conversations[0].turns[0].turnId],
            },
          ]
        : [],
      status,
      createdAt: now,
      updatedAt: now,
    };
  });

  return facts;
};

export const generatePersonas = (
  options: PersonaGenerationOptions,
): Persona[] => {
  const rng = createRng(options.seed);
  const now = options.now ?? isoNow();
  const personas: Persona[] = [];
  for (let i = 0; i < options.count; i += 1) {
    const general = randomGeneralProfile(rng);
    const domains = generateDomains(rng);
    const profile = randomProfileCore(rng, general, now);
    const reliability = randomReliability(rng, now);
    const datingProfile = domains.includes("dating")
      ? randomDatingProfile(rng, now, general)
      : undefined;
    const friendshipProfile = domains.includes("friendship")
      ? randomFriendshipProfile(rng)
      : undefined;
    const businessProfile = domains.includes("business")
      ? randomBusinessProfile(rng)
      : undefined;

    const persona: Persona = {
      id: i,
      status: "active",
      domains,
      general,
      profile,
      domainProfiles: {
        dating: datingProfile,
        friendship: friendshipProfile,
        business: businessProfile,
      },
      matchPreferences: {
        blockedPersonaIds: [],
        excludedPersonaIds: [],
        preferredAgeMin: datingProfile?.datingPreferences.preferredAgeMin,
        preferredAgeMax: datingProfile?.datingPreferences.preferredAgeMax,
        preferredGenders: datingProfile?.datingPreferences.preferredGenders,
        bodyTypePreferences:
          datingProfile?.datingPreferences.bodyTypePreferences,
        reliabilityMinScore: rng.bool(0.3)
          ? clampNumber(reliability.score - 0.2, 0, 1)
          : undefined,
      },
      reliability,
      feedbackBias: {
        harshnessScore: 0.5,
        positivityBias: 0.5,
        redFlagFrequency: 0,
        notes: [],
        stats: {
          givenCount: 0,
          averageRating: 0,
          negativeRate: 0,
          redFlagRate: 0,
          lastUpdated: now,
        },
        lastUpdated: now,
      },
      facts: [],
      conversations: [],
      blockedPersonaIds: [],
      lastUpdated: now,
      profileRevision: 0,
    };

    const convoCount = rng.int(0, 20);
    persona.conversations = Array.from({ length: convoCount }, (_, idx) =>
      generateConversation(rng, persona.id, idx, now),
    );
    persona.facts = generateFacts(rng, persona, now);
    personas.push(persona);
  }
  return personas;
};

const randomFeedbackIssue = (
  rng: ReturnType<typeof createRng>,
): FeedbackIssue => {
  const issues: Array<{
    code: string;
    severity: FeedbackIssueSeverity;
    redFlag: boolean;
  }> = [
    { code: "late_cancel", severity: "medium", redFlag: false },
    { code: "no_show", severity: "high", redFlag: true },
    { code: "ghosted", severity: "high", redFlag: true },
    { code: "rude", severity: "medium", redFlag: true },
    { code: "positive_vibe", severity: "low", redFlag: false },
  ];
  const issue = rng.pick(issues);
  return { ...issue, notes: rng.pick(["", "pattern", "one-off", "follow up"]) };
};

const sentimentFromRating = (rating: number): FeedbackSentiment => {
  if (rating >= 4) {
    return "positive";
  }
  if (rating <= 2) {
    return "negative";
  }
  return "neutral";
};

const generateFeedbackQueue = (
  rng: ReturnType<typeof createRng>,
  personas: Persona[],
  count: number,
  now: string,
): FeedbackEntry[] => {
  const entries: FeedbackEntry[] = [];
  for (let i = 0; i < count; i += 1) {
    const from = rng.pick(personas);
    const to = rng.pick(personas.filter((persona) => persona.id !== from.id));
    const rating = clampInt(rng.int(1, 5), 1, 5);
    const sentiment = sentimentFromRating(rating);
    const issueCount = sentiment === "negative" ? rng.int(1, 2) : rng.int(0, 1);
    const issues = Array.from({ length: issueCount }, () =>
      randomFeedbackIssue(rng),
    );
    const redFlags = issues
      .filter((issue) => issue.redFlag)
      .map((issue) => issue.code);
    entries.push({
      id: `fb-${i}-${from.id}-${to.id}`,
      fromPersonaId: from.id,
      toPersonaId: to.id,
      meetingId: rng.bool(0.7) ? `m-${from.id}-${to.id}-${i}` : undefined,
      rating,
      sentiment,
      issues,
      redFlags,
      notes: rng.pick([
        "Great conversation.",
        "Scheduling was tricky.",
        "Felt a little off.",
        "Would meet again.",
        "Low energy vibe.",
      ]),
      createdAt: now,
      processed: false,
      source: rng.pick(["meeting", "group_event", "conversation"]),
    });
  }
  return entries;
};

const buildMatchGraph = (
  feedback: FeedbackEntry[],
  now: string,
): MatchGraph => {
  const edges = feedback
    .filter((entry) => entry.rating >= 4)
    .map((entry) => ({
      from: entry.fromPersonaId,
      to: entry.toPersonaId,
      weight: clampNumber(entry.rating / 5, 0, 1),
      type: "feedback_positive" as const,
      createdAt: now,
    }));
  return { edges };
};

export const generateEngineState = (
  options: EngineSeedOptions,
): EngineState => {
  const rng = createRng(options.seed);
  const now = options.now ?? isoNow();
  const personas = generatePersonas({
    seed: options.seed,
    count: options.personaCount,
    now,
  });
  const feedbackQueue = generateFeedbackQueue(
    rng,
    personas,
    options.feedbackEvents,
    now,
  );

  return {
    personas,
    matches: [],
    meetings: [],
    feedbackQueue,
    safetyReports: [],
    communities: [],
    credits: [],
    messages: [],
    matchGraph: buildMatchGraph(feedbackQueue, now),
  };
};

export const DEFAULT_SEED = 20260118;
export const DEFAULT_NOW = "2026-01-18T12:00:00.000Z";
export const DEFAULT_PERSONAS = generatePersonas({
  seed: DEFAULT_SEED,
  count: 200,
  now: DEFAULT_NOW,
});
export const DEFAULT_ENGINE_STATE = generateEngineState({
  seed: DEFAULT_SEED,
  personaCount: 200,
  feedbackEvents: 240,
  now: DEFAULT_NOW,
});
