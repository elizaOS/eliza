import { upsertFact } from "@engine/facts";
import type {
  AvailabilityWindow,
  Cadence,
  DayOfWeek,
  DomainMode,
  Persona,
  PersonaStatus,
  ReliabilitySignals,
} from "@engine/types";
import { unique } from "@engine/utils";

export type FlowIntent = "love" | "friendship" | "business" | "open";

export type FlowStage =
  | "entry"
  | "verification"
  | "intent"
  | "deeper"
  | "validation"
  | "validation_retry"
  | "profile"
  | "discovery"
  | "commitment"
  | "commitment_retry"
  | "availability"
  | "matching_queue"
  | "group_meeting"
  | "active"
  | "paused"
  | "cooloff"
  | "blocked";

export type FlowDiscoveryAnswer = {
  questionId: string;
  theme: string;
  question: string;
  answer: string;
};

export type FlowPersonaProfile = {
  fullName?: string | null;
  pronouns?: string | null;
  age?: number | null;
  city?: string | null;
  timeZone?: string | null;
  gender?: string | null;
  orientation?: string | null;
  desiredFeeling?: string | null;
  coreDesire?: string | null;
  values?: string | null;
  dealbreakers?: string | null;
  communityTags?: string[] | null;
  discoveryAnswers?: FlowDiscoveryAnswer[];
  preferredDays?: string | null;
  preferredTimes?: string[] | null;
  meetingCadence?: string | null;
};

export type FlowReliabilityUpdate = {
  attendedCount?: number;
  noShowCount?: number;
  lateCancelCount?: number;
  ghostCount?: number;
  score?: number;
};

export type FlowPersonaUpdate = {
  intent?: FlowIntent;
  stage?: FlowStage;
  status?: PersonaStatus;
  profile?: FlowPersonaProfile;
  reliability?: FlowReliabilityUpdate;
};

export type PersonaUpdateResult = {
  persona: Persona;
  changed: boolean;
};

const TIME_RANGES: Record<string, { start: number; end: number }> = {
  morning: { start: 9 * 60, end: 12 * 60 },
  afternoon: { start: 12 * 60, end: 17 * 60 },
  evening: { start: 17 * 60, end: 21 * 60 },
  flexible: { start: 9 * 60, end: 21 * 60 },
};

const CADENCE_LOOKUP: Record<Cadence, true> = {
  weekly: true,
  biweekly: true,
  monthly: true,
  flexible: true,
};

const normalizeText = (value: string | null | undefined): string | null => {
  if (!value) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const normalizeCsv = (value: string | null | undefined): string[] => {
  if (!value) return [];
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
};

const normalizeTags = (value: string[] | null | undefined): string[] =>
  Array.isArray(value)
    ? value.map((entry) => entry.trim()).filter(Boolean)
    : [];

const isCadence = (value: string | null | undefined): value is Cadence =>
  value ? Object.hasOwn(CADENCE_LOOKUP, value) : false;

const mapPreferredDays = (pref: string | null | undefined): DayOfWeek[] => {
  switch (pref) {
    case "weekdays":
      return ["mon", "tue", "wed", "thu", "fri"];
    case "weekends":
      return ["sat", "sun"];
    default:
      return ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
  }
};

const mapPreferredTimesToWindows = (
  times: string[] | null | undefined,
  days: DayOfWeek[],
): AvailabilityWindow[] => {
  const windows: AvailabilityWindow[] = [];
  const selectedTimes = times && times.length > 0 ? times : ["flexible"];
  for (const day of days) {
    for (const time of selectedTimes) {
      const range = TIME_RANGES[time] ?? TIME_RANGES.flexible;
      windows.push({
        day,
        startMinutes: range.start,
        endMinutes: range.end,
      });
    }
  }
  return windows;
};

const mapIntentToDomains = (intent: FlowIntent): DomainMode[] => {
  switch (intent) {
    case "love":
      return ["dating"];
    case "friendship":
      return ["friendship"];
    case "business":
      return ["business"];
    case "open":
      return ["dating", "friendship", "business"];
    default:
      return ["general"];
  }
};

const mapStageToStatus = (stage: FlowStage): PersonaStatus | null => {
  switch (stage) {
    case "active":
      return "active";
    case "paused":
      return "paused";
    case "blocked":
      return "blocked";
    default:
      return null;
  }
};

const arraysEqual = (a: string[], b: string[]): boolean =>
  a.length === b.length && a.every((value, index) => value === b[index]);

const updateReliability = (
  reliability: ReliabilitySignals,
  update: FlowReliabilityUpdate,
  now: string,
): boolean => {
  let changed = false;
  if (
    typeof update.attendedCount === "number" &&
    update.attendedCount !== reliability.attendedCount
  ) {
    reliability.attendedCount = update.attendedCount;
    changed = true;
  }
  if (
    typeof update.noShowCount === "number" &&
    update.noShowCount !== reliability.noShowCount
  ) {
    reliability.noShowCount = update.noShowCount;
    changed = true;
  }
  if (
    typeof update.lateCancelCount === "number" &&
    update.lateCancelCount !== reliability.lateCancelCount
  ) {
    reliability.lateCancelCount = update.lateCancelCount;
    changed = true;
  }
  if (
    typeof update.ghostCount === "number" &&
    update.ghostCount !== reliability.ghostCount
  ) {
    reliability.ghostCount = update.ghostCount;
    changed = true;
  }
  if (typeof update.score === "number" && update.score !== reliability.score) {
    reliability.score = update.score;
    changed = true;
  }
  if (changed) {
    reliability.lastUpdated = now;
  }
  return changed;
};

export const applyFlowPersonaUpdate = (
  persona: Persona,
  update: FlowPersonaUpdate,
  now: string,
): PersonaUpdateResult => {
  const next = structuredClone(persona);
  let changed = false;

  const status =
    update.status ?? (update.stage ? mapStageToStatus(update.stage) : null);
  if (status && status !== next.status) {
    next.status = status;
    changed = true;
  }

  if (update.intent) {
    const domains = mapIntentToDomains(update.intent);
    if (!arraysEqual(next.domains, domains)) {
      next.domains = domains;
      changed = true;
    }
  }

  if (update.profile) {
    const profile = update.profile;
    const name = normalizeText(profile.fullName);
    if (name && name !== next.profile.name) {
      next.profile.name = name;
      next.general.name = name;
      changed = true;
    }

    const pronouns = normalizeText(profile.pronouns);
    if (pronouns && pronouns !== next.profile.pronouns) {
      next.profile.pronouns = pronouns;
      next.general.pronouns = pronouns;
      changed = true;
    }

    if (typeof profile.age === "number" && profile.age !== next.general.age) {
      next.general.age = profile.age;
      changed = true;
    }

    const city = normalizeText(profile.city);
    if (city && city !== next.general.location.city) {
      next.general.location.city = city;
      changed = true;
    }

    const timeZone = normalizeText(profile.timeZone);
    if (timeZone && timeZone !== next.profile.availability.timeZone) {
      next.profile.availability.timeZone = timeZone;
      next.general.location.timeZone = timeZone;
      changed = true;
    }

    const gender = normalizeText(profile.gender);
    if (gender && gender !== next.general.genderIdentity) {
      next.general.genderIdentity = gender;
      changed = true;
    }

    const cadenceValue = normalizeText(profile.meetingCadence);
    if (
      cadenceValue &&
      isCadence(cadenceValue) &&
      cadenceValue !== next.profile.meetingCadence
    ) {
      next.profile.meetingCadence = cadenceValue;
      changed = true;
    }

    const interestList = normalizeCsv(profile.values);
    if (interestList.length > 0) {
      const interests = unique([...next.profile.interests, ...interestList]);
      if (!arraysEqual(next.profile.interests, interests)) {
        next.profile.interests = interests;
        next.general.values = unique([...next.general.values, ...interestList]);
        changed = true;
      }
    }

    const communityTags = normalizeTags(profile.communityTags);
    if (communityTags.length > 0) {
      const tags = unique([...next.profile.communityTags, ...communityTags]);
      if (!arraysEqual(next.profile.communityTags, tags)) {
        next.profile.communityTags = tags;
        changed = true;
      }
    }

    const coreDesire = normalizeText(profile.coreDesire);
    if (coreDesire) {
      const goals = unique([...next.profile.connectionGoals, coreDesire]);
      if (!arraysEqual(next.profile.connectionGoals, goals)) {
        next.profile.connectionGoals = goals;
        changed = true;
      }
    }

    const desiredFeeling = normalizeText(profile.desiredFeeling);
    if (desiredFeeling) {
      upsertFact(
        next,
        {
          type: "feeling",
          key: "desired_feeling",
          value: desiredFeeling,
          confidence: 0.7,
          evidence: [],
        },
        now,
      );
      changed = true;
    }

    if (profile.preferredDays || profile.preferredTimes) {
      const days = mapPreferredDays(profile.preferredDays);
      const windows = mapPreferredTimesToWindows(profile.preferredTimes, days);
      if (windows.length > 0) {
        next.profile.availability.weekly = windows;
        changed = true;
      }
    }

    if (profile.discoveryAnswers && profile.discoveryAnswers.length > 0) {
      for (const answer of profile.discoveryAnswers) {
        upsertFact(
          next,
          {
            type: "discovery",
            key: `discovery:${answer.questionId}`,
            value: answer.answer,
            confidence: 0.7,
            evidence: [],
          },
          now,
        );
      }
      changed = true;
    }

    if (next.domains.includes("dating")) {
      const dating = next.domainProfiles.dating ?? {
        datingPreferences: {
          preferredGenders: [],
          preferredAgeMin: Math.max(18, next.general.age - 10),
          preferredAgeMax: next.general.age + 10,
          relationshipGoal: update.intent === "love" ? "long_term" : "open",
          dealbreakers: [],
          bodyTypePreferences: [],
          attractivenessImportance: 5,
          fitnessImportance: 5,
          orientation: profile.orientation ?? "prefer_not_say",
        },
        attractionProfile: {
          appearance: {
            attractiveness: 5,
            build: "average",
            hairColor: "unknown",
            eyeColor: "unknown",
            skinTone: 5,
            ethnicity: "unknown",
            perceivedGender: 5,
            distinctiveFeatures: [],
          },
          assessments: [],
        },
        hobbies: next.profile.interests,
        personalityTraits: [],
        communicationStyle: "balanced",
        lifestyle: "active",
        relationshipGoal: update.intent === "love" ? "long_term" : "open",
        schedule: next.profile.meetingCadence,
      };

      const orientation = normalizeText(profile.orientation);
      if (orientation && orientation !== dating.datingPreferences.orientation) {
        dating.datingPreferences.orientation = orientation;
        changed = true;
      }

      const dealbreakers = normalizeCsv(profile.dealbreakers);
      if (
        dealbreakers.length > 0 &&
        !arraysEqual(dating.datingPreferences.dealbreakers, dealbreakers)
      ) {
        dating.datingPreferences.dealbreakers = dealbreakers;
        changed = true;
      }

      next.domainProfiles.dating = dating;
    }

    if (next.domains.includes("friendship")) {
      const friendship = next.domainProfiles.friendship ?? {
        vibe: "chill",
        energy: "balanced",
        socialStyle: "one_on_one",
        interests: next.profile.interests,
        hobbies: next.profile.interests,
        boundaries: [],
      };
      if (interestList.length > 0) {
        const interests = unique([...friendship.interests, ...interestList]);
        friendship.interests = interests;
        friendship.hobbies = unique([...friendship.hobbies, ...interestList]);
        changed = true;
      }
      next.domainProfiles.friendship = friendship;
    }

    if (next.domains.includes("business")) {
      const business = next.domainProfiles.business ?? {
        jobTitle: "",
        industry: "",
        roles: [],
        seekingRoles: [],
        skills: next.profile.interests,
        experienceYears: 0,
        companyStage: "any",
        commitment: "flexible",
        values: next.profile.interests,
      };
      if (interestList.length > 0) {
        business.skills = unique([...business.skills, ...interestList]);
        business.values = unique([...business.values, ...interestList]);
        changed = true;
      }
      next.domainProfiles.business = business;
    }
  }

  if (update.reliability) {
    const reliabilityChanged = updateReliability(
      next.reliability,
      update.reliability,
      now,
    );
    changed = changed || reliabilityChanged;
  }

  if (changed) {
    next.lastUpdated = now;
    next.profileRevision += 1;
  }

  return { persona: next, changed };
};
