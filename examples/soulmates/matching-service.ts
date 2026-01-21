/** Matching service: converts flow data to personas, runs matching, notifies on matches */

import type {
  IAgentRuntime,
  JsonValue,
  Memory,
  Metadata,
  Plugin,
  Provider,
  ProviderResult,
  UUID,
} from "@elizaos/core";
import { logger, Service } from "@elizaos/core";
import { v4 as uuidv4 } from "uuid";
import { runEngineTick } from "./engine/engine";
import { proposeMeetingRecord } from "./engine/scheduling";
import type {
  AvailabilityWindow,
  DayOfWeek,
  DomainMode,
  EngineState,
  FeedbackEntry,
  MatchRecord,
  Persona,
  PersonaId,
  SafetyReport,
} from "./engine/types";
import type { UserFlowState } from "./flow-orchestrator";
import { getUserState, saveUserState } from "./flow-orchestrator";
import { ensureSystemContext } from "./system-context";

export interface MatchProposal {
  matchId: string;
  personaAId: UUID;
  personaBId: UUID;
  domain: DomainMode;
  score: number;
  reasons: string[];
  createdAt: number;
  status: "proposed" | "accepted" | "declined" | "expired";
}

export interface MatchingServiceConfig {
  matchingIntervalMs: number;
  matchesPerTick: number;
  minMatchScore: number;
  autoScheduleMeetings: boolean;
  /** Defaults for user profile fields - externalized for configuration */
  defaults: {
    timeZone: string;
    country: string;
    age: number;
    pronouns: string;
  };
}

const DEFAULT_CONFIG: MatchingServiceConfig = {
  matchingIntervalMs: 60 * 60 * 1000,
  matchesPerTick: 10,
  minMatchScore: 30,
  autoScheduleMeetings: true,
  defaults: {
    timeZone: process.env.DEFAULT_TIMEZONE ?? "America/New_York",
    country: process.env.DEFAULT_COUNTRY ?? "US",
    age: Number(process.env.DEFAULT_AGE) || 25,
    pronouns: process.env.DEFAULT_PRONOUNS ?? "they/them",
  },
};

const ENGINE_STATE_COMPONENT = "soulmates_engine_state";
const ENTITY_PERSONA_MAP_COMPONENT = "soulmates_entity_persona_map";
const FEEDBACK_STATE_COMPONENT = "soulmates_meeting_feedback";

interface EntityPersonaMapping {
  entityToPersona: Record<string, PersonaId>;
  personaToEntity: Record<string, string>;
  nextPersonaId: number;
}

type RescheduleResult = {
  meetingId: string;
  timeText: string;
};

type CancellationInfo = {
  isLate: boolean;
  requiresConfirm: boolean;
};

type FeedbackPayload = {
  meetingId: string;
  rating: number;
  sentiment: "positive" | "neutral" | "negative";
  meetAgain?: boolean;
  notes?: string;
};

type MeetingFeedbackEntry = {
  rating: number;
  sentiment: "positive" | "neutral" | "negative";
  meetAgain?: boolean;
  notes?: string;
};

type MeetingFeedbackState = {
  responses: Record<string, Record<string, MeetingFeedbackEntry>>;
};

interface SmsService extends Service {
  sendSms: (
    to: string,
    body: string,
    mediaUrl?: string[],
    fromOverride?: string,
  ) => Promise<{
    sid: string;
  }>;
}

const MAX_RESCHEDULES = Number(process.env.SOULMATES_MAX_RESCHEDULES ?? "3");

const notifyAdmin = async (
  runtime: IAgentRuntime,
  message: string,
): Promise<void> => {
  const adminNumber = process.env.SOULMATES_ADMIN_ALERT_NUMBER;
  if (!adminNumber) return;
  const twilio = runtime.getService<SmsService>("twilio");
  if (!twilio) return;
  await twilio.sendSms(adminNumber, message);
};

// Runtime reference for storage
let _matchingRuntime: IAgentRuntime | null = null;

function setMatchingRuntime(runtime: IAgentRuntime): void {
  _matchingRuntime = runtime;
}

const toJsonRecord = (value: object): Record<string, JsonValue> =>
  JSON.parse(JSON.stringify(value)) as Record<string, JsonValue>;

async function loadEngineState(): Promise<EngineState> {
  if (!_matchingRuntime) {
    return createEmptyEngineState();
  }

  const component = await _matchingRuntime.getComponent(
    _matchingRuntime.agentId,
    ENGINE_STATE_COMPONENT,
  );

  if (!component?.data) {
    return createEmptyEngineState();
  }

  if (isEngineState(component.data)) {
    return component.data;
  }
  return createEmptyEngineState();
}

async function saveEngineState(state: EngineState): Promise<void> {
  if (!_matchingRuntime) {
    logger.warn("[MatchingService] Cannot save engine state - runtime not set");
    return;
  }

  try {
    const { roomId, worldId } = await ensureSystemContext(_matchingRuntime);
    const { v4: uuidv4 } = await import("uuid");
    const existing = await _matchingRuntime.getComponent(
      _matchingRuntime.agentId,
      ENGINE_STATE_COMPONENT,
    );
    const resolvedWorldId =
      existing?.worldId && existing.worldId !== "" ? existing.worldId : worldId;

    const component = {
      id: existing?.id || (uuidv4() as UUID),
      entityId: _matchingRuntime.agentId,
      agentId: _matchingRuntime.agentId,
      roomId: existing?.roomId ?? roomId,
      worldId: resolvedWorldId,
      sourceEntityId: _matchingRuntime.agentId,
      type: ENGINE_STATE_COMPONENT,
      createdAt: existing?.createdAt || Date.now(),
      data: toJsonRecord(state),
    };

    if (existing) {
      await _matchingRuntime.updateComponent(component);
    } else {
      await _matchingRuntime.createComponent(component);
    }
  } catch (err) {
    logger.warn(`[MatchingService] Failed to save engine state: ${err}`);
  }
}

async function loadEntityPersonaMapping(): Promise<EntityPersonaMapping> {
  if (!_matchingRuntime) {
    return { entityToPersona: {}, personaToEntity: {}, nextPersonaId: 1 };
  }

  const component = await _matchingRuntime.getComponent(
    _matchingRuntime.agentId,
    ENTITY_PERSONA_MAP_COMPONENT,
  );

  if (!component) {
    return { entityToPersona: {}, personaToEntity: {}, nextPersonaId: 1 };
  }

  return component.data as unknown as EntityPersonaMapping;
}

async function saveEntityPersonaMapping(
  mapping: EntityPersonaMapping,
): Promise<void> {
  if (!_matchingRuntime) {
    return;
  }

  try {
    const { roomId, worldId } = await ensureSystemContext(_matchingRuntime);
    const { v4: uuidv4 } = await import("uuid");
    const existing = await _matchingRuntime.getComponent(
      _matchingRuntime.agentId,
      ENTITY_PERSONA_MAP_COMPONENT,
    );
    const resolvedWorldId =
      existing?.worldId && existing.worldId !== "" ? existing.worldId : worldId;

    const component = {
      id: existing?.id || (uuidv4() as UUID),
      entityId: _matchingRuntime.agentId,
      agentId: _matchingRuntime.agentId,
      roomId: existing?.roomId ?? roomId,
      worldId: resolvedWorldId,
      sourceEntityId: _matchingRuntime.agentId,
      type: ENTITY_PERSONA_MAP_COMPONENT,
      createdAt: existing?.createdAt || Date.now(),
      data: toJsonRecord(mapping),
    };

    if (existing) {
      await _matchingRuntime.updateComponent(component);
    } else {
      await _matchingRuntime.createComponent(component);
    }
  } catch (err) {
    logger.warn(`[MatchingService] Failed to save persona mapping: ${err}`);
  }
}

async function loadFeedbackState(): Promise<MeetingFeedbackState> {
  if (!_matchingRuntime) {
    return { responses: {} };
  }
  const component = await _matchingRuntime.getComponent(
    _matchingRuntime.agentId,
    FEEDBACK_STATE_COMPONENT,
  );
  const data = component?.data;
  const responsesRaw = data?.responses;
  const responses =
    responsesRaw && typeof responsesRaw === "object"
      ? (responsesRaw as Record<string, Record<string, MeetingFeedbackEntry>>)
      : {};
  return { responses };
}

async function saveFeedbackState(state: MeetingFeedbackState): Promise<void> {
  if (!_matchingRuntime) {
    return;
  }
  try {
    const { roomId, worldId } = await ensureSystemContext(_matchingRuntime);
    const { v4: uuidv4 } = await import("uuid");
    const existing = await _matchingRuntime.getComponent(
      _matchingRuntime.agentId,
      FEEDBACK_STATE_COMPONENT,
    );
    const resolvedWorldId =
      existing?.worldId && existing.worldId !== "" ? existing.worldId : worldId;
    const component = {
      id: existing?.id || (uuidv4() as UUID),
      entityId: _matchingRuntime.agentId,
      agentId: _matchingRuntime.agentId,
      roomId: existing?.roomId ?? roomId,
      worldId: resolvedWorldId,
      sourceEntityId: _matchingRuntime.agentId,
      type: FEEDBACK_STATE_COMPONENT,
      createdAt: existing?.createdAt || Date.now(),
      data: {
        responses: state.responses,
      },
    };

    if (existing) {
      await _matchingRuntime.updateComponent(component);
    } else {
      await _matchingRuntime.createComponent(component);
    }
  } catch (err) {
    logger.warn(`[MatchingService] Failed to save feedback state: ${err}`);
  }
}

function createEmptyEngineState(): EngineState {
  return {
    personas: [],
    matches: [],
    meetings: [],
    feedbackQueue: [],
    safetyReports: [],
    communities: [],
    credits: [],
    messages: [],
    matchGraph: { edges: [] },
  };
}

const isEngineState = (data: object): data is EngineState => {
  if (Array.isArray(data)) {
    return false;
  }
  const record = data as {
    personas?: JsonValue;
    matches?: JsonValue;
    meetings?: JsonValue;
    feedbackQueue?: JsonValue;
  };
  return (
    Array.isArray(record.personas) &&
    Array.isArray(record.matches) &&
    Array.isArray(record.meetings) &&
    Array.isArray(record.feedbackQueue)
  );
};

function mapPreferredDays(pref: string | undefined): DayOfWeek[] {
  switch (pref) {
    case "weekdays":
      return ["mon", "tue", "wed", "thu", "fri"];
    case "weekends":
      return ["sat", "sun"];
    default:
      return ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
  }
}

function mapPreferredTimesToWindows(
  times: string[] | undefined,
  days: DayOfWeek[],
): AvailabilityWindow[] {
  const windows: AvailabilityWindow[] = [];
  const timeRanges: Record<string, { start: number; end: number }> = {
    morning: { start: 9 * 60, end: 12 * 60 },
    afternoon: { start: 12 * 60, end: 17 * 60 },
    evening: { start: 17 * 60, end: 21 * 60 },
    flexible: { start: 9 * 60, end: 21 * 60 },
  };

  const selectedTimes = times?.length ? times : ["flexible"];

  for (const day of days) {
    for (const time of selectedTimes) {
      const range = timeRanges[time] ?? timeRanges.flexible;
      windows.push({
        day,
        startMinutes: range.start,
        endMinutes: range.end,
      });
    }
  }

  return windows;
}

const intersectStrings = (a: string[], b: string[]): string[] => {
  const set = new Set(a.map((entry) => entry.toLowerCase()));
  return b.filter((entry) => set.has(entry.toLowerCase()));
};

const formatMeetingTimeText = (scheduledAt: string, timeZone: string): string =>
  new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(scheduledAt));

async function flowStateToPersona(
  entityId: UUID,
  flowState: UserFlowState,
): Promise<Persona | null> {
  // Need at least basic profile info
  if (!flowState.profile.fullName || !flowState.profile.city) {
    return null;
  }

  // Get or create persona ID from persistent mapping
  const mapping = await loadEntityPersonaMapping();
  let personaId = mapping.entityToPersona[entityId];
  if (!personaId) {
    personaId = mapping.nextPersonaId++;
    mapping.entityToPersona[entityId] = personaId;
    mapping.personaToEntity[String(personaId)] = entityId;
    await saveEntityPersonaMapping(mapping);
  }

  const now = new Date().toISOString();
  const days = mapPreferredDays(flowState.profile.preferredDays);
  const windows = mapPreferredTimesToWindows(
    flowState.profile.preferredTimes,
    days,
  );

  // Determine domains based on intent
  const domains: DomainMode[] = [];
  switch (flowState.intent) {
    case "love":
      domains.push("dating");
      break;
    case "friendship":
      domains.push("friendship");
      break;
    case "business":
      domains.push("business");
      break;
    case "open":
      domains.push("dating", "friendship", "business");
      break;
    default:
      domains.push("general");
  }

  // Parse values into interests
  const interests =
    flowState.profile.values
      ?.split(",")
      .map((v) => v.trim())
      .filter(Boolean) ?? [];

  const { defaults } = DEFAULT_CONFIG;

  const pronouns = flowState.profile.pronouns ?? defaults.pronouns;
  const communityTags = flowState.profile.communityTags ?? [];
  const persona: Persona = {
    id: personaId,
    status: flowState.stage === "active" ? "active" : "pending",
    domains,
    general: {
      name: flowState.profile.fullName,
      age: flowState.profile.age ?? defaults.age,
      genderIdentity: flowState.profile.gender ?? "prefer_not_say",
      pronouns,
      location: {
        city: flowState.profile.city,
        country: defaults.country,
        timeZone: flowState.profile.timeZone ?? defaults.timeZone,
      },
      values: interests,
      bio: flowState.profile.coreDesire ?? "",
    },
    profile: {
      name: flowState.profile.fullName,
      pronouns,
      availability: {
        timeZone: flowState.profile.timeZone ?? defaults.timeZone,
        weekly: windows,
        exceptions: [],
      },
      interests,
      meetingCadence:
        (flowState.profile.meetingCadence as
          | "weekly"
          | "biweekly"
          | "monthly"
          | "flexible") ?? "flexible",
      connectionGoals: flowState.profile.coreDesire
        ? [flowState.profile.coreDesire]
        : [],
      communityTags,
      feedbackSummary: {
        sentimentScore: 0,
        positiveCount: 0,
        neutralCount: 0,
        negativeCount: 0,
        lastUpdated: now,
        redFlagTags: [],
        issueTags: [],
      },
    },
    domainProfiles: {},
    matchPreferences: {
      blockedPersonaIds: [],
      excludedPersonaIds: [],
    },
    reliability: {
      score: flowState.reliability.score,
      lastUpdated: now,
      attendedCount: flowState.reliability.attendedCount,
      lateCancelCount: flowState.reliability.lateCancelCount,
      noShowCount: flowState.reliability.noShowCount,
      ghostCount: flowState.reliability.ghostCount,
      ghostedByOthersCount: 0,
      canceledOnByOthersCount: 0,
      responseLatencyAvgMinutes: 30,
      history: [],
    },
    feedbackBias: {
      harshnessScore: 0,
      positivityBias: 0,
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
    profileRevision: 1,
    // Credit-based priority boost: 50 points if active, 0 otherwise
    priorityBoost:
      flowState.priorityMatchUntil && flowState.priorityMatchUntil > Date.now()
        ? 50
        : 0,
  };

  // Add domain-specific profiles
  if (domains.includes("dating")) {
    persona.domainProfiles.dating = {
      datingPreferences: {
        preferredGenders: [],
        preferredAgeMin: Math.max(18, (flowState.profile.age ?? 25) - 10),
        preferredAgeMax: (flowState.profile.age ?? 25) + 10,
        relationshipGoal: flowState.intent === "love" ? "long_term" : "open",
        dealbreakers:
          flowState.profile.dealbreakers?.split(",").map((d) => d.trim()) ?? [],
        bodyTypePreferences: [],
        attractivenessImportance: 5,
        fitnessImportance: 5,
        orientation: flowState.profile.orientation ?? "prefer_not_say",
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
      hobbies: interests,
      personalityTraits: [],
      communicationStyle: "balanced",
      lifestyle: "active",
      relationshipGoal: "open",
      schedule: flowState.profile.meetingCadence ?? "flexible",
    };
  }

  if (domains.includes("friendship")) {
    persona.domainProfiles.friendship = {
      vibe: "chill",
      energy: "balanced",
      socialStyle: "one_on_one",
      interests,
      hobbies: interests,
      boundaries: [],
    };
  }

  if (domains.includes("business")) {
    persona.domainProfiles.business = {
      jobTitle: "",
      industry: "",
      roles: [],
      seekingRoles: [],
      skills: interests,
      experienceYears: 0,
      companyStage: "any",
      commitment: "flexible",
      values: interests,
    };
  }

  return persona;
}

async function getEntityFromPersona(
  personaId: PersonaId,
): Promise<UUID | undefined> {
  const mapping = await loadEntityPersonaMapping();
  return mapping.personaToEntity[String(personaId)] as UUID | undefined;
}

export class MatchingService extends Service {
  static serviceType = "SOULMATES_MATCHING";
  capabilityDescription = "Runs matching algorithm and manages match lifecycle";

  config?: Metadata;
  private settings: MatchingServiceConfig;
  private matchingInterval: ReturnType<typeof setInterval> | null = null;

  constructor(
    runtime?: IAgentRuntime,
    config?: Partial<MatchingServiceConfig>,
  ) {
    super(runtime);
    this.settings = { ...DEFAULT_CONFIG, ...config };
    this.config = toJsonRecord(this.settings);
    if (runtime) {
      setMatchingRuntime(runtime);
    }
  }

  static async start(runtime: IAgentRuntime): Promise<Service> {
    setMatchingRuntime(runtime);
    const service = new MatchingService(runtime);
    service.startMatchingLoop();
    logger.info("[MatchingService] Started with persistent storage");
    return service;
  }

  async stop(): Promise<void> {
    if (this.matchingInterval) {
      clearInterval(this.matchingInterval);
      this.matchingInterval = null;
    }
    logger.info("[MatchingService] Stopped");
  }

  private startMatchingLoop(): void {
    // Delay initial tick to allow database to initialize
    const initialDelay = 5000;
    setTimeout(() => {
      this.runMatchingTick().catch((err) =>
        logger.error(`[MatchingService] Error in matching tick: ${err}`),
      );
    }, initialDelay);

    // Then run on interval
    this.matchingInterval = setInterval(
      () =>
        this.runMatchingTick().catch((err) =>
          logger.error(`[MatchingService] Error in matching tick: ${err}`),
        ),
      this.settings.matchingIntervalMs,
    );
  }

  async runMatchingTick(): Promise<void> {
    logger.debug("[MatchingService] Running matching tick...");

    // Load current engine state from persistent storage
    const engineState = await loadEngineState();

    // Sync personas from flow states
    await this.syncPersonas(engineState);

    const now = new Date().toISOString();
    const result = await runEngineTick(
      engineState,
      {
        now,
        batchSize: this.settings.matchesPerTick,
        maxCandidates: 50,
        smallPassTopK: 10,
        largePassTopK: 5,
        graphHops: 2,
        matchCooldownDays: 30,
        reliabilityWeight: 1.0,
        matchDomains: ["dating", "friendship", "business", "general"],
        autoScheduleMatches: this.settings.autoScheduleMeetings,
      },
      {
        idFactory: uuidv4,
      },
    );

    // Save updated engine state
    await saveEngineState(result.state);

    if (result.matchesCreated.length > 0) {
      logger.info(
        `[MatchingService] Created ${result.matchesCreated.length} matches`,
      );

      // Notify users about new matches
      for (const match of result.matchesCreated) {
        await this.notifyMatch(match);
      }
    }
  }

  private async syncPersonas(_engineState: EngineState): Promise<void> {
    // Personas are synced via addOrUpdatePersona when flow state changes
  }

  async addOrUpdatePersona(
    entityId: UUID,
    flowState: UserFlowState,
  ): Promise<void> {
    const persona = await flowStateToPersona(entityId, flowState);
    if (!persona) {
      return;
    }

    const engineState = await loadEngineState();
    const existingIndex = engineState.personas.findIndex(
      (p) => p.id === persona.id,
    );
    if (existingIndex >= 0) {
      engineState.personas[existingIndex] = persona;
    } else {
      engineState.personas.push(persona);
    }
    await saveEngineState(engineState);

    logger.debug(`[MatchingService] Updated persona ${persona.id}`);
  }

  private async notifyMatch(match: MatchRecord): Promise<void> {
    const entityA = await getEntityFromPersona(match.personaA);
    const entityB = await getEntityFromPersona(match.personaB);

    if (!entityA || !entityB) {
      logger.warn(
        `[MatchingService] Could not find entities for match ${match.matchId}`,
      );
      return;
    }

    const twilioService = this.runtime.getService<SmsService>("twilio");
    if (!twilioService) {
      throw new Error("Twilio service not available for match notifications");
    }

    const engineState = await loadEngineState();
    const personaA = engineState.personas.find((p) => p.id === match.personaA);
    const personaB = engineState.personas.find((p) => p.id === match.personaB);
    const meeting = match.scheduledMeetingId
      ? engineState.meetings.find(
          (m) => m.meetingId === match.scheduledMeetingId,
        )
      : undefined;

    const stateA = await getUserState(entityA);
    const stateB = await getUserState(entityB);

    if (!stateA?.consent.granted || !stateB?.consent.granted) {
      logger.warn(
        `[MatchingService] Consent missing for match ${match.matchId}`,
      );
      return;
    }

    const phoneA = stateA?.phoneNumber;
    const phoneB = stateB?.phoneNumber;
    if (!phoneA || !phoneB) {
      logger.warn(
        `[MatchingService] Missing phone numbers for match ${match.matchId}`,
      );
      return;
    }

    const interestsA = personaA?.profile.interests ?? [];
    const interestsB = personaB?.profile.interests ?? [];
    const shared = intersectStrings(interestsA, interestsB);
    const interest = shared[0] ?? "something you both care about";

    const phase1 = `I found someone who shares ${interest}. Want to see where this goes?`;
    await Promise.all([
      twilioService.sendSms(phoneA, phase1),
      twilioService.sendSms(phoneB, phase1),
    ]);

    const now = Date.now();
    const delayHours = Number(
      process.env.SOULMATES_MATCH_REVEAL_PHASE_HOURS ?? "6",
    );
    const delayMs = Number.isFinite(delayHours)
      ? delayHours * 60 * 60 * 1000
      : 6 * 60 * 60 * 1000;

    const updateState = async (
      _entityId: UUID,
      current: UserFlowState | null,
    ) => {
      if (!current) return;
      if (!current.activeMatchIds.includes(match.matchId)) {
        current.activeMatchIds.push(match.matchId);
      }
      if (
        meeting?.meetingId &&
        !current.activeMeetingIds.includes(meeting.meetingId)
      ) {
        current.activeMeetingIds.push(meeting.meetingId);
      }
      current.matchReveals.push({
        matchId: match.matchId,
        phase: 1,
        nextPhaseAt: now + delayMs,
        interest,
        meetingId: meeting?.meetingId,
      });
      current.stage =
        current.stage === "matching_queue" ? "active" : current.stage;
      await saveUserState(current);
    };

    await updateState(entityA, stateA);
    await updateState(entityB, stateB);
  }

  async getMatchesForEntity(entityId: UUID): Promise<MatchRecord[]> {
    const mapping = await loadEntityPersonaMapping();
    const personaId = mapping.entityToPersona[entityId];
    if (!personaId) return [];

    const engineState = await loadEngineState();
    return engineState.matches.filter(
      (m) =>
        (m.personaA === personaId || m.personaB === personaId) &&
        m.status !== "canceled" &&
        m.status !== "expired",
    );
  }

  async getMatchPartner(entityId: UUID, matchId: string): Promise<UUID | null> {
    const mapping = await loadEntityPersonaMapping();
    const personaId = mapping.entityToPersona[entityId];
    if (!personaId) return null;

    const engineState = await loadEngineState();
    const match = engineState.matches.find((m) => m.matchId === matchId);
    if (!match) return null;

    const partnerId =
      match.personaA === personaId ? match.personaB : match.personaA;
    return (await getEntityFromPersona(partnerId)) ?? null;
  }

  async getMeetingPartnerEntity(
    meetingId: string,
    requesterId: UUID,
  ): Promise<UUID | null> {
    const engineState = await loadEngineState();
    const meeting = engineState.meetings.find(
      (entry) => entry.meetingId === meetingId,
    );
    if (!meeting) return null;
    const match = engineState.matches.find(
      (entry) => entry.matchId === meeting.matchId,
    );
    if (!match) return null;

    const mapping = await loadEntityPersonaMapping();
    const requesterPersona = mapping.entityToPersona[requesterId];
    if (!requesterPersona) return null;

    if (
      match.personaA !== requesterPersona &&
      match.personaB !== requesterPersona
    ) {
      return null;
    }
    const partnerId =
      match.personaA === requesterPersona ? match.personaB : match.personaA;
    return (await getEntityFromPersona(partnerId)) ?? null;
  }

  async getEntityForPersona(personaId: PersonaId): Promise<UUID | null> {
    return (await getEntityFromPersona(personaId)) ?? null;
  }

  async getPersonaIdForEntity(entityId: UUID): Promise<PersonaId | null> {
    const mapping = await loadEntityPersonaMapping();
    return mapping.entityToPersona[entityId] ?? null;
  }

  async confirmMeeting(meetingId: string, entityId: UUID): Promise<boolean> {
    const engineState = await loadEngineState();
    const meeting = engineState.meetings.find((m) => m.meetingId === meetingId);
    if (!meeting) return false;
    const match = engineState.matches.find(
      (m) => m.matchId === meeting.matchId,
    );
    if (!match) return false;

    const mapping = await loadEntityPersonaMapping();
    const personaId = mapping.entityToPersona[entityId];
    if (!personaId) return false;
    if (match.personaA !== personaId && match.personaB !== personaId)
      return false;

    match.status = "scheduled";
    meeting.status = "scheduled";
    await saveEngineState(engineState);
    return true;
  }

  async getCancellationInfo(
    meetingId: string,
    entityId: UUID,
  ): Promise<CancellationInfo> {
    const engineState = await loadEngineState();
    const meeting = engineState.meetings.find((m) => m.meetingId === meetingId);
    if (!meeting) return { isLate: false, requiresConfirm: false };
    const match = engineState.matches.find(
      (m) => m.matchId === meeting.matchId,
    );
    if (!match) return { isLate: false, requiresConfirm: false };

    const mapping = await loadEntityPersonaMapping();
    const personaId = mapping.entityToPersona[entityId];
    if (!personaId) return { isLate: false, requiresConfirm: false };
    if (match.personaA !== personaId && match.personaB !== personaId) {
      return { isLate: false, requiresConfirm: false };
    }

    const scheduledAt = Date.parse(meeting.scheduledAt);
    if (!Number.isFinite(scheduledAt))
      return { isLate: false, requiresConfirm: false };

    const hoursUntil = (scheduledAt - Date.now()) / (60 * 60 * 1000);
    const lateHours = Number(process.env.SOULMATES_LATE_CANCEL_HOURS ?? "24");
    const confirmHours = Number(
      process.env.SOULMATES_CANCEL_CONFIRM_HOURS ?? "2",
    );
    const lateThreshold = Number.isFinite(lateHours) ? lateHours : 24;
    const confirmThreshold = Number.isFinite(confirmHours) ? confirmHours : 2;

    return {
      isLate: hoursUntil <= lateThreshold,
      requiresConfirm: hoursUntil <= confirmThreshold,
    };
  }

  async cancelMeeting(meetingId: string, entityId: UUID): Promise<boolean> {
    const engineState = await loadEngineState();
    const meeting = engineState.meetings.find((m) => m.meetingId === meetingId);
    if (!meeting) return false;
    const match = engineState.matches.find(
      (m) => m.matchId === meeting.matchId,
    );
    if (!match) return false;

    const mapping = await loadEntityPersonaMapping();
    const personaId = mapping.entityToPersona[entityId];
    if (!personaId) return false;
    if (match.personaA !== personaId && match.personaB !== personaId)
      return false;

    meeting.status = "canceled";
    meeting.cancellationReason = "user_cancelled";
    match.status = "canceled";
    await saveEngineState(engineState);
    return true;
  }

  async rescheduleMeeting(
    meetingId: string,
    entityId: UUID,
  ): Promise<RescheduleResult | null> {
    const engineState = await loadEngineState();
    const meeting = engineState.meetings.find((m) => m.meetingId === meetingId);
    if (!meeting) return null;
    const match = engineState.matches.find(
      (m) => m.matchId === meeting.matchId,
    );
    if (!match) return null;

    if (meeting.rescheduleCount >= MAX_RESCHEDULES) {
      if (this.runtime) {
        await notifyAdmin(
          this.runtime,
          `Reschedule limit reached for match ${match.matchId}. Manual scheduling needed.`,
        );
      }
      return null;
    }

    const mapping = await loadEntityPersonaMapping();
    const personaId = mapping.entityToPersona[entityId];
    if (!personaId) return null;
    if (match.personaA !== personaId && match.personaB !== personaId)
      return null;

    const personaA = engineState.personas.find((p) => p.id === match.personaA);
    const personaB = engineState.personas.find((p) => p.id === match.personaB);
    if (!personaA || !personaB) return null;

    const now = new Date().toISOString();
    const minMinutes = Number(
      process.env.SOULMATES_MIN_AVAILABILITY_MINUTES ?? "120",
    );
    const minAvailabilityMinutes = Number.isFinite(minMinutes)
      ? minMinutes
      : 120;

    const proposed = await proposeMeetingRecord(
      match,
      personaA,
      personaB,
      now,
      undefined,
      minAvailabilityMinutes,
      uuidv4,
    );
    if (!proposed) return null;

    meeting.scheduledAt = proposed.scheduledAt;
    meeting.location = proposed.location;
    meeting.rescheduleCount += 1;
    meeting.status = "scheduled";
    await saveEngineState(engineState);

    const timeZone = personaA.profile.availability.timeZone;
    return {
      meetingId: meeting.meetingId,
      timeText: formatMeetingTimeText(meeting.scheduledAt, timeZone),
    };
  }

  async sendWarmIntro(matchId: string, requesterId: UUID): Promise<boolean> {
    const engineState = await loadEngineState();
    const match = engineState.matches.find((m) => m.matchId === matchId);
    if (!match) return false;

    const entityA = await getEntityFromPersona(match.personaA);
    const entityB = await getEntityFromPersona(match.personaB);
    if (!entityA || !entityB) return false;
    if (requesterId !== entityA && requesterId !== entityB) return false;

    const stateA = await getUserState(entityA);
    const stateB = await getUserState(entityB);
    const phoneA = stateA?.phoneNumber;
    const phoneB = stateB?.phoneNumber;
    if (!phoneA || !phoneB) return false;

    const nameA = stateA?.profile.fullName ?? "someone";
    const nameB = stateB?.profile.fullName ?? "someone";
    const introA = `Intro: ${nameB} is someone I think you'll enjoy meeting. If you're open, reply YES and I will coordinate a time.`;
    const introB = `Intro: ${nameA} is someone I think you'll enjoy meeting. If you're open, reply YES and I will coordinate a time.`;

    const twilioService = this.runtime.getService<SmsService>("twilio");
    if (!twilioService) return false;
    await Promise.all([
      twilioService.sendSms(phoneA, introA),
      twilioService.sendSms(phoneB, introB),
    ]);
    return true;
  }

  async recordFeedback(
    entityId: UUID,
    feedback: FeedbackPayload,
  ): Promise<boolean> {
    const engineState = await loadEngineState();
    const meeting = engineState.meetings.find(
      (m) => m.meetingId === feedback.meetingId,
    );
    if (!meeting) return false;
    const match = engineState.matches.find(
      (m) => m.matchId === meeting.matchId,
    );
    if (!match) return false;

    const mapping = await loadEntityPersonaMapping();
    const personaId = mapping.entityToPersona[entityId];
    if (!personaId) return false;
    const partnerId =
      match.personaA === personaId ? match.personaB : match.personaA;

    const entry: FeedbackEntry = {
      id: uuidv4(),
      fromPersonaId: personaId,
      toPersonaId: partnerId,
      meetingId: meeting.meetingId,
      rating: feedback.rating,
      sentiment: feedback.sentiment,
      issues: [],
      redFlags: [],
      notes: feedback.notes ?? "",
      createdAt: new Date().toISOString(),
      processed: false,
      source: "meeting",
    };
    engineState.feedbackQueue.push(entry);
    meeting.status = "completed";
    await saveEngineState(engineState);

    const feedbackState = await loadFeedbackState();
    const meetingResponses = feedbackState.responses[meeting.meetingId] ?? {};
    meetingResponses[String(personaId)] = {
      rating: feedback.rating,
      sentiment: feedback.sentiment,
      meetAgain: feedback.meetAgain,
      notes: feedback.notes,
    };
    feedbackState.responses[meeting.meetingId] = meetingResponses;
    await saveFeedbackState(feedbackState);

    if (feedback.sentiment === "negative") {
      await this.blockMatch(match.matchId, entityId);
      return true;
    }

    const partnerFeedback = meetingResponses[String(partnerId)];
    if (
      feedback.meetAgain &&
      feedback.sentiment === "positive" &&
      partnerFeedback?.meetAgain &&
      partnerFeedback.sentiment === "positive"
    ) {
      await this.scheduleRepeatMeeting(match, engineState);
    }
    return true;
  }

  async reportSafety(
    entityId: UUID,
    severity: SafetyReport["severity"],
    notes: string,
    transcriptRef?: string,
  ): Promise<boolean> {
    const engineState = await loadEngineState();
    const mapping = await loadEntityPersonaMapping();
    const personaId = mapping.entityToPersona[entityId];
    if (!personaId) return false;

    const activeMatch = engineState.matches.find(
      (match) => match.personaA === personaId || match.personaB === personaId,
    );
    const targetId = activeMatch
      ? activeMatch.personaA === personaId
        ? activeMatch.personaB
        : activeMatch.personaA
      : personaId;

    const report: SafetyReport = {
      reportId: uuidv4(),
      reporterId: personaId,
      targetId,
      severity,
      notes: notes.trim(),
      createdAt: new Date().toISOString(),
      status: "open",
      transcriptRef,
    };
    engineState.safetyReports.push(report);

    if (severity !== "level1") {
      const reporter = engineState.personas.find((p) => p.id === personaId);
      const target = engineState.personas.find((p) => p.id === targetId);
      if (reporter && target) {
        if (!reporter.blockedPersonaIds.includes(target.id)) {
          reporter.blockedPersonaIds.push(target.id);
        }
        if (!target.blockedPersonaIds.includes(reporter.id)) {
          target.blockedPersonaIds.push(reporter.id);
        }
        if (!reporter.matchPreferences.blockedPersonaIds.includes(target.id)) {
          reporter.matchPreferences.blockedPersonaIds.push(target.id);
        }
        if (!target.matchPreferences.blockedPersonaIds.includes(reporter.id)) {
          target.matchPreferences.blockedPersonaIds.push(reporter.id);
        }
        target.status = "blocked";
      }

      for (const match of engineState.matches) {
        if (match.personaA !== targetId && match.personaB !== targetId) {
          continue;
        }
        if (match.status === "completed" || match.status === "canceled") {
          continue;
        }
        match.status = "canceled";
        if (match.scheduledMeetingId) {
          const meeting = engineState.meetings.find(
            (m) => m.meetingId === match.scheduledMeetingId,
          );
          if (meeting && meeting.status !== "canceled") {
            meeting.status = "canceled";
            meeting.cancellationReason = "safety_report";
          }
        }
      }

      const targetEntity = await getEntityFromPersona(targetId);
      if (targetEntity) {
        const targetState = await getUserState(targetEntity);
        if (targetState) {
          targetState.stage = "blocked";
          targetState.activeMatchIds = [];
          targetState.activeMeetingIds = [];
          targetState.checkIn.status = "paused";
          await saveUserState(targetState);
        }
      }
    }

    await saveEngineState(engineState);
    return true;
  }

  async blockMatch(matchId: string, entityId: UUID): Promise<boolean> {
    const engineState = await loadEngineState();
    const match = engineState.matches.find((m) => m.matchId === matchId);
    if (!match) return false;

    const mapping = await loadEntityPersonaMapping();
    const personaId = mapping.entityToPersona[entityId];
    if (!personaId) return false;
    if (match.personaA !== personaId && match.personaB !== personaId)
      return false;

    const personaA = engineState.personas.find((p) => p.id === match.personaA);
    const personaB = engineState.personas.find((p) => p.id === match.personaB);
    if (!personaA || !personaB) return false;

    if (!personaA.blockedPersonaIds.includes(personaB.id)) {
      personaA.blockedPersonaIds.push(personaB.id);
    }
    if (!personaB.blockedPersonaIds.includes(personaA.id)) {
      personaB.blockedPersonaIds.push(personaA.id);
    }
    if (!personaA.matchPreferences.blockedPersonaIds.includes(personaB.id)) {
      personaA.matchPreferences.blockedPersonaIds.push(personaB.id);
    }
    if (!personaB.matchPreferences.blockedPersonaIds.includes(personaA.id)) {
      personaB.matchPreferences.blockedPersonaIds.push(personaA.id);
    }

    match.status = "canceled";
    await saveEngineState(engineState);
    return true;
  }

  private async scheduleRepeatMeeting(
    match: MatchRecord,
    engineState: EngineState,
  ): Promise<void> {
    const personaA = engineState.personas.find((p) => p.id === match.personaA);
    const personaB = engineState.personas.find((p) => p.id === match.personaB);
    if (!personaA || !personaB) return;

    const now = new Date().toISOString();
    const minMinutes = Number(
      process.env.SOULMATES_MIN_AVAILABILITY_MINUTES ?? "120",
    );
    const minAvailabilityMinutes = Number.isFinite(minMinutes)
      ? minMinutes
      : 120;
    const proposed = await proposeMeetingRecord(
      match,
      personaA,
      personaB,
      now,
      undefined,
      minAvailabilityMinutes,
      uuidv4,
    );
    if (!proposed) return;

    engineState.meetings.push(proposed);
    match.status = "scheduled";
    match.scheduledMeetingId = proposed.meetingId;
    await saveEngineState(engineState);

    const entityA = await getEntityFromPersona(match.personaA);
    const entityB = await getEntityFromPersona(match.personaB);
    if (!entityA || !entityB) return;
    const stateA = await getUserState(entityA);
    const stateB = await getUserState(entityB);
    const phoneA = stateA?.phoneNumber;
    const phoneB = stateB?.phoneNumber;
    if (!phoneA || !phoneB) return;
    const timeZone = personaA.profile.availability.timeZone;
    const timeText = formatMeetingTimeText(proposed.scheduledAt, timeZone);
    const twilioService = this.runtime.getService<SmsService>("twilio");
    if (!twilioService) return;
    await Promise.all([
      twilioService.sendSms(
        phoneA,
        `Great news. I scheduled a follow-up meeting for ${timeText}. Reply YES to confirm.`,
      ),
      twilioService.sendSms(
        phoneB,
        `Great news. I scheduled a follow-up meeting for ${timeText}. Reply YES to confirm.`,
      ),
    ]);
    const nowMs = Date.now();
    if (stateA) {
      stateA.pendingMeetingConfirmation = proposed.meetingId;
      stateA.pendingMeetingConfirmationAt = nowMs;
      stateA.pendingMeetingEscalatedAt = undefined;
      if (!stateA.activeMeetingIds.includes(proposed.meetingId)) {
        stateA.activeMeetingIds.push(proposed.meetingId);
      }
      await saveUserState(stateA);
    }
    if (stateB) {
      stateB.pendingMeetingConfirmation = proposed.meetingId;
      stateB.pendingMeetingConfirmationAt = nowMs;
      stateB.pendingMeetingEscalatedAt = undefined;
      if (!stateB.activeMeetingIds.includes(proposed.meetingId)) {
        stateB.activeMeetingIds.push(proposed.meetingId);
      }
      await saveUserState(stateB);
    }
  }

  async acceptMatch(matchId: string, entityId: UUID): Promise<boolean> {
    const engineState = await loadEngineState();
    const match = engineState.matches.find((m) => m.matchId === matchId);
    if (!match) return false;

    const mapping = await loadEntityPersonaMapping();
    const personaId = mapping.entityToPersona[entityId];
    if (!personaId) return false;

    if (match.personaA !== personaId && match.personaB !== personaId) {
      return false;
    }

    match.status = "accepted";
    await saveEngineState(engineState);
    return true;
  }

  async declineMatch(matchId: string, entityId: UUID): Promise<boolean> {
    const engineState = await loadEngineState();
    const match = engineState.matches.find((m) => m.matchId === matchId);
    if (!match) return false;

    const mapping = await loadEntityPersonaMapping();
    const personaId = mapping.entityToPersona[entityId];
    if (!personaId) return false;

    if (match.personaA !== personaId && match.personaB !== personaId) {
      return false;
    }

    match.status = "canceled";
    await saveEngineState(engineState);
    return true;
  }

  async getEngineState(): Promise<EngineState> {
    return loadEngineState();
  }
}

export const matchingContextProvider: Provider = {
  name: "SOULMATES_MATCHING_CONTEXT",
  description: "Provides context about matches and matching status",
  get: async (
    runtime: IAgentRuntime,
    message: Memory,
  ): Promise<ProviderResult> => {
    setMatchingRuntime(runtime);
    const matchingService =
      runtime.getService<MatchingService>("SOULMATES_MATCHING");
    if (!matchingService) {
      return { text: "" };
    }

    const entityId = message.entityId;
    if (!entityId) {
      return { text: "" };
    }

    const matches = await matchingService.getMatchesForEntity(entityId);
    if (matches.length === 0) {
      return { text: "" };
    }

    const sections: string[] = [];
    sections.push("Current matches:");

    for (const match of matches.slice(0, 5)) {
      const partnerId = await matchingService.getMatchPartner(
        entityId,
        match.matchId,
      );
      const partnerState = partnerId ? await getUserState(partnerId) : null;
      const partnerName = partnerState?.profile.fullName ?? "Someone";

      sections.push(
        `- Match with ${partnerName} (${match.domain}): ${match.status}, score: ${match.assessment.score}`,
      );
    }

    return {
      text: `<matching_context>\n${sections.join("\n")}\n</matching_context>`,
    };
  },
};

export const matchingServicePlugin: Plugin = {
  name: "soulmates-matching-service",
  description: "Matching engine integration for Soulmates",
  services: [MatchingService],
  providers: [matchingContextProvider],
};

export default matchingServicePlugin;
