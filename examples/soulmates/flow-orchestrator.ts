/** User lifecycle state machine: entry -> onboarding -> matching -> active/paused/cooloff */

import type {
  Action,
  IAgentRuntime,
  JsonValue,
  Memory,
  Metadata,
  MetadataValue,
  Plugin,
  Provider,
  ProviderResult,
  Service,
  TargetInfo,
  Task,
  TaskWorker,
  UUID,
} from "@elizaos/core";
import type { FormService } from "@elizaos/plugin-form";
import type { MatchingService } from "./matching-service";
import {
  generateHowWeHelp,
  generateInsight,
  hashStringToSeed,
  pickDiscoveryQuestions,
} from "./soulmates-form";
import { ensureSystemContext } from "./system-context";

export type UserStage =
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

export type Intent = "love" | "friendship" | "business" | "open";

export type CheckInStatus = "idle" | "pending" | "paused";
export type GroupMeetingStatus = "pending" | "scheduled" | "completed";
export type FeedbackStage = "rating" | "meet_again" | "notes" | "complete";
export type MatchRevealPhase = 1 | 2 | 3 | 4;

export type VerificationStatus =
  | "unverified"
  | "pending"
  | "verified"
  | "locked";

export type VerificationState = {
  status: VerificationStatus;
  code?: string;
  attempts: number;
  requestedAt?: number;
  verifiedAt?: number;
};

export type CheckInState = {
  status: CheckInStatus;
  lastSentAt?: number;
  lastReminderAt?: number;
  lastResponseAt?: number;
  nextCheckInAt?: number;
  pendingDecision?: "pause_or_skip" | "later";
};

export type GroupMeetingState = {
  status: GroupMeetingStatus;
  scheduledAt?: number;
  completedAt?: number;
  groupId?: string;
  locationName?: string;
  locationAddress?: string;
  reminderSentAt?: number;
  feedbackRequestedAt?: number;
  validated?: boolean;
  reviewScore?: number;
};

export type FeedbackState = {
  meetingId: string;
  stage: FeedbackStage;
  askedAt: number;
  rating?: number;
  sentiment?: "positive" | "neutral" | "negative";
  meetAgain?: boolean;
  notes?: string;
};

export type MatchRevealState = {
  matchId: string;
  phase: MatchRevealPhase;
  nextPhaseAt: number;
  interest?: string;
  meetingId?: string;
};

export type DiscoveryPromptState = {
  questionId: string;
  theme: string;
  question: string;
  askedAt: number;
};

export type PendingCancelState = {
  meetingId: string;
  requestedAt: number;
};

export interface UserFlowState extends Record<string, MetadataValue> {
  entityId: UUID;
  stage: UserStage;
  intent?: Intent;
  phoneNumber?: string;
  consent: {
    granted: boolean;
    grantedAt?: number;
    privacyGranted?: boolean;
    privacyGrantedAt?: number;
    safetyGranted?: boolean;
    safetyGrantedAt?: number;
  };
  verification: VerificationState;
  validationAttempts: number;
  commitmentAttempts: number;
  ghostCount: number;
  lateCancelCount: number;
  cooloffUntil?: number;
  pausedAt?: number;
  activeMatchIds: string[];
  activeMeetingIds: string[];
  pendingMeetingConfirmation?: string;
  pendingMeetingConfirmationAt?: number;
  pendingMeetingEscalatedAt?: number;
  pendingIntroMatchId?: string;
  pendingFeedback?: FeedbackState;
  pendingCancel?: PendingCancelState;
  pendingDiscoveryQuestion?: DiscoveryPromptState;
  lastInsightSentAt?: number;
  matchReveals: MatchRevealState[];
  groupMeeting: GroupMeetingState;
  checkIn: CheckInState;
  lastInteractionAt: number;
  createdAt: number;
  updatedAt: number;

  // Collected profile data
  profile: {
    fullName?: string;
    pronouns?: string;
    age?: number;
    city?: string;
    timeZone?: string;
    gender?: string;
    orientation?: string;
    desiredFeeling?: string;
    coreDesire?: string;
    values?: string;
    dealbreakers?: string;
    communityTags?: string[];
    discoveryAnswers?: Array<{
      questionId: string;
      theme: string;
      question: string;
      answer: string;
    }>;
    preferredDays?: string;
    preferredTimes?: string[];
    meetingCadence?: string;
  };

  // Validation state
  validation: {
    lastInsight?: string;
    correction?: string;
  };

  // Reliability signals
  reliability: {
    attendedCount: number;
    noShowCount: number;
    lateCancelCount: number;
    ghostCount: number;
    score: number;
    lastCoachedAt?: number;
  };

  // Reactivation tracking
  reactivationAttempts?: number;
  lastReactivationAttemptAt?: number;

  // Credit-based priority
  priorityMatchUntil?: number;
  priorityScheduleUntil?: number;
  expandedFiltersUntil?: number;
}

const FLOW_STATE_COMPONENT = "soulmates_flow_state";
const FLOW_INDEX_COMPONENT = "soulmates_flow_index";
const APP_SYNC_PATH = "/api/engine/persona";
const E164_REGEX = /^\+[1-9]\d{7,14}$/;
const VERIFICATION_CODE_LENGTH = 4;
const MAX_VERIFICATION_ATTEMPTS = 3;

// Runtime reference for storage operations (set during plugin init)
let _runtime: IAgentRuntime | null = null;

function setRuntime(runtime: IAgentRuntime): void {
  _runtime = runtime;
}

function getRuntime(): IAgentRuntime {
  if (!_runtime) {
    throw new Error(
      "[FlowOrchestrator] Runtime not initialized. Call setRuntime first.",
    );
  }
  return _runtime;
}

const generateVerificationCode = (): string => {
  const min = 10 ** (VERIFICATION_CODE_LENGTH - 1);
  const max = 10 ** VERIFICATION_CODE_LENGTH - 1;
  return String(Math.floor(min + Math.random() * (max - min + 1)));
};

async function issueVerificationCode(
  runtime: IAgentRuntime,
  state: UserFlowState,
  roomId: UUID,
): Promise<void> {
  const entityId = state.entityId;
  const code = generateVerificationCode();
  state.verification.status = "pending";
  state.verification.code = code;
  state.verification.attempts = 0;
  state.verification.requestedAt = Date.now();
  await saveUserState(state);
  await runtime.sendMessageToTarget({ roomId, entityId } as TargetInfo, {
    text: `Your verification code is ${code}. Please reply with this code to continue.`,
  });
}

type FlowIndex = {
  entityIds: UUID[];
};

async function loadFlowIndex(): Promise<FlowIndex> {
  const runtime = getRuntime();
  const component = await runtime.getComponent(
    runtime.agentId,
    FLOW_INDEX_COMPONENT,
  );
  const data = component?.data;
  const raw = data?.entityIds;
  const entityIds =
    Array.isArray(raw) && raw.every((entry) => typeof entry === "string")
      ? (raw as UUID[])
      : [];
  return { entityIds };
}

async function saveFlowIndex(index: FlowIndex): Promise<void> {
  const runtime = getRuntime();
  const existing = await runtime.getComponent(
    runtime.agentId,
    FLOW_INDEX_COMPONENT,
  );
  const { roomId, worldId } = await ensureSystemContext(runtime);
  const { v4: uuidv4 } = await import("uuid");
  const resolvedWorldId =
    existing?.worldId && existing.worldId !== "" ? existing.worldId : worldId;

  const component = {
    id: existing?.id || (uuidv4() as UUID),
    entityId: runtime.agentId,
    agentId: runtime.agentId,
    roomId: existing?.roomId ?? roomId,
    worldId: resolvedWorldId,
    sourceEntityId: runtime.agentId,
    type: FLOW_INDEX_COMPONENT,
    createdAt: existing?.createdAt || Date.now(),
    data: {
      entityIds: index.entityIds,
    },
  };

  if (existing) {
    await runtime.updateComponent(component);
  } else {
    await runtime.createComponent(component);
  }
}

async function registerEntity(entityId: UUID): Promise<void> {
  const index = await loadFlowIndex();
  if (!index.entityIds.includes(entityId)) {
    index.entityIds.push(entityId);
    await saveFlowIndex(index);
  }
}

async function getUserState(entityId: UUID): Promise<UserFlowState | null> {
  const runtime = getRuntime();
  const componentType = `${FLOW_STATE_COMPONENT}:${entityId}`;
  const component = await runtime.getComponent(entityId, componentType);
  if (!component) return null;
  if (!component.data) return null;
  if (!isUserFlowState(component.data)) return null;
  const state = normalizeUserState(component.data);
  await registerEntity(entityId);
  return state;
}

function isUserFlowState(data: Metadata): data is UserFlowState {
  return (
    typeof data.entityId === "string" &&
    typeof data.stage === "string" &&
    typeof data.createdAt === "number" &&
    typeof data.updatedAt === "number"
  );
}

function normalizeUserState(state: UserFlowState): UserFlowState {
  if (!state.profile) {
    state.profile = {};
  }
  if (!state.consent) {
    state.consent = { granted: false };
  }
  if (state.consent.privacyGranted === undefined) {
    state.consent.privacyGranted = false;
  }
  if (state.consent.safetyGranted === undefined) {
    state.consent.safetyGranted = false;
  }
  if (!state.verification) {
    state.verification = { status: "unverified", attempts: 0 };
  }
  if (!state.activeMatchIds) {
    state.activeMatchIds = [];
  }
  if (!state.activeMeetingIds) {
    state.activeMeetingIds = [];
  }
  if (!state.matchReveals) {
    state.matchReveals = [];
  }
  if (!state.groupMeeting) {
    state.groupMeeting = { status: "pending" };
  }
  if (!state.checkIn) {
    state.checkIn = { status: "idle" };
  }
  if (!state.activeMatchIds) {
    state.activeMatchIds = [];
  }
  if (!state.activeMeetingIds) {
    state.activeMeetingIds = [];
  }
  if (!state.matchReveals) {
    state.matchReveals = [];
  }
  return state;
}

async function saveUserState(state: UserFlowState): Promise<void> {
  const runtime = getRuntime();
  state.updatedAt = Date.now();

  const componentType = `${FLOW_STATE_COMPONENT}:${state.entityId}`;
  const existing = await runtime.getComponent(state.entityId, componentType);
  const { roomId, worldId } = await ensureSystemContext(runtime);

  const { v4: uuidv4 } = await import("uuid");
  const resolvedWorldId =
    existing?.worldId && existing.worldId !== "" ? existing.worldId : worldId;

  const component = {
    id: existing?.id || (uuidv4() as UUID),
    entityId: state.entityId,
    agentId: runtime.agentId,
    roomId: existing?.roomId ?? roomId,
    worldId: resolvedWorldId,
    sourceEntityId: runtime.agentId,
    type: componentType,
    createdAt: existing?.createdAt || Date.now(),
    data: state as Metadata,
  };

  if (existing) {
    await runtime.updateComponent(component);
  } else {
    await runtime.createComponent(component);
  }

  await syncUserStateToApp(state);
}

async function createUserState(entityId: UUID): Promise<UserFlowState> {
  const now = Date.now();
  const state: UserFlowState = {
    entityId,
    stage: "entry",
    validationAttempts: 0,
    commitmentAttempts: 0,
    ghostCount: 0,
    lateCancelCount: 0,
    consent: {
      granted: false,
    },
    verification: {
      status: "unverified",
      attempts: 0,
    },
    activeMatchIds: [],
    activeMeetingIds: [],
    matchReveals: [],
    groupMeeting: {
      status: "pending",
    },
    checkIn: {
      status: "idle",
    },
    lastInteractionAt: now,
    createdAt: now,
    updatedAt: now,
    profile: {},
    validation: {},
    reliability: {
      attendedCount: 0,
      noShowCount: 0,
      lateCancelCount: 0,
      ghostCount: 0,
      score: 1.0,
    },
  };
  await saveUserState(state);
  await registerEntity(entityId);
  return state;
}

async function getOrCreateUserState(entityId: UUID): Promise<UserFlowState> {
  const existing = await getUserState(entityId);
  if (existing) return existing;
  return createUserState(entityId);
}

async function listUserStates(): Promise<UserFlowState[]> {
  const index = await loadFlowIndex();
  const states = await Promise.all(
    index.entityIds.map((id) => getUserState(id)),
  );
  return states.filter((state): state is UserFlowState => Boolean(state));
}

async function touchUserState(
  entityId: UUID,
  phoneNumber?: string,
): Promise<void> {
  const state = await getUserState(entityId);
  if (!state) return;
  let updated = false;
  if (phoneNumber && state.phoneNumber !== phoneNumber) {
    state.phoneNumber = phoneNumber;
    updated = true;
  }
  const now = Date.now();
  if (state.lastInteractionAt !== now) {
    state.lastInteractionAt = now;
    updated = true;
  }
  if (updated) {
    await saveUserState(state);
  }
}

type PersonaSyncPayload = {
  phone: string;
  intent?: Intent;
  stage: UserStage;
  profile: {
    fullName?: string;
    age?: number;
    city?: string;
    timeZone?: string;
    gender?: string;
    orientation?: string;
    desiredFeeling?: string;
    coreDesire?: string;
    values?: string;
    dealbreakers?: string;
    discoveryAnswers?: Array<{
      questionId: string;
      theme: string;
      question: string;
      answer: string;
    }>;
    preferredDays?: string;
    preferredTimes?: string[];
    meetingCadence?: string;
  };
  reliability: {
    attendedCount: number;
    noShowCount: number;
    lateCancelCount: number;
    ghostCount: number;
    score: number;
  };
};

function extractPhone(entityId: UUID): string | null {
  const value = String(entityId);
  return E164_REGEX.test(value) ? value : null;
}

async function syncUserStateToApp(state: UserFlowState): Promise<void> {
  const baseUrlRaw = process.env.SOULMATES_APP_API_BASE_URL?.trim();
  const secret = process.env.SOULMATES_APP_API_SECRET?.trim();
  if (!baseUrlRaw || !secret) {
    return;
  }

  const phone = extractPhone(state.entityId);
  if (!phone) {
    return;
  }

  const baseUrl = baseUrlRaw.endsWith("/")
    ? baseUrlRaw.slice(0, -1)
    : baseUrlRaw;
  const payload: PersonaSyncPayload = {
    phone,
    intent: state.intent,
    stage: state.stage,
    profile: {
      fullName: state.profile.fullName,
      age: state.profile.age,
      city: state.profile.city,
      timeZone: state.profile.timeZone,
      gender: state.profile.gender,
      orientation: state.profile.orientation,
      desiredFeeling: state.profile.desiredFeeling,
      coreDesire: state.profile.coreDesire,
      values: state.profile.values,
      dealbreakers: state.profile.dealbreakers,
      discoveryAnswers: state.profile.discoveryAnswers,
      preferredDays: state.profile.preferredDays,
      preferredTimes: state.profile.preferredTimes,
      meetingCadence: state.profile.meetingCadence,
    },
    reliability: {
      attendedCount: state.reliability.attendedCount,
      noShowCount: state.reliability.noShowCount,
      lateCancelCount: state.reliability.lateCancelCount,
      ghostCount: state.reliability.ghostCount,
      score: state.reliability.score,
    },
  };

  try {
    const response = await fetch(`${baseUrl}${APP_SYNC_PATH}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${secret}`,
      },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      const text = await response.text();
      const logger = _runtime?.logger ?? console;
      logger.warn(`[FlowOrchestrator] Sync failed: ${response.status} ${text}`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const logger = _runtime?.logger ?? console;
    logger.warn(`[FlowOrchestrator] Sync error: ${message}`);
  }
}

const STAGE_FLOW: Record<UserStage, UserStage | null> = {
  entry: "verification",
  verification: "deeper",
  intent: "deeper",
  deeper: "validation",
  validation: "profile",
  validation_retry: "validation",
  profile: "discovery",
  discovery: "commitment",
  commitment: "availability",
  commitment_retry: "commitment",
  availability: "matching_queue",
  matching_queue: "group_meeting",
  group_meeting: "active",
  active: null,
  paused: null,
  cooloff: null,
  blocked: null,
};

const STAGE_FORMS: Record<UserStage, string | null> = {
  entry: "soulmates_entry",
  verification: "soulmates_verification",
  intent: null,
  deeper: "soulmates_deeper",
  validation: "soulmates_validation",
  validation_retry: "soulmates_validation",
  profile: "soulmates_profile",
  discovery: "soulmates_discovery",
  commitment: "soulmates_commitment",
  commitment_retry: "soulmates_commitment",
  availability: "soulmates_availability",
  matching_queue: null,
  group_meeting: null,
  active: null,
  paused: null,
  cooloff: null,
  blocked: null,
};

async function advanceStage(
  runtime: IAgentRuntime,
  state: UserFlowState,
  roomId: UUID,
): Promise<{ nextStage: UserStage; message: string } | null> {
  const nextStage = STAGE_FLOW[state.stage];
  if (!nextStage) {
    return null;
  }

  state.stage = nextStage;
  state.lastInteractionAt = Date.now();
  if (nextStage === "group_meeting") {
    scheduleGroupMeeting(state);
  }
  await saveUserState(state);

  if (nextStage === "verification") {
    await issueVerificationCode(runtime, state, roomId);
  }

  // Start the appropriate form if there is one
  const formId = STAGE_FORMS[nextStage];
  if (formId) {
    const formService = runtime.getService<FormService>("FORM");
    if (!formService) {
      runtime.logger.error(
        `[FlowOrchestrator] FormService not available for stage ${nextStage}`,
      );
      throw new Error(
        `FormService required for stage ${nextStage} but not available`,
      );
    }
    const initialValues = getInitialValuesForStage(state, nextStage);
    await formService.startSession(formId, state.entityId, roomId, {
      context: { stage: nextStage },
      initialValues,
    });
  }

  const message = getStageTransitionMessage(state, nextStage);
  return { nextStage, message };
}

function scheduleGroupMeeting(state: UserFlowState): void {
  const raw = process.env.SOULMATES_GROUP_MEETING_ISO;
  if (!raw) {
    state.groupMeeting = { status: "pending" };
    return;
  }
  const scheduledAt = Date.parse(raw);
  if (!Number.isFinite(scheduledAt)) {
    state.groupMeeting = { status: "pending" };
    return;
  }
  state.groupMeeting = {
    status: "scheduled",
    scheduledAt,
  };
}

function formatMeetingTime(timeMs: number, timeZone?: string): string {
  const date = new Date(timeMs);
  return new Intl.DateTimeFormat("en-US", {
    timeZone: timeZone || "UTC",
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function getInitialValuesForStage(
  state: UserFlowState,
  stage: UserStage,
): Record<string, JsonValue> {
  switch (stage) {
    case "validation":
    case "validation_retry": {
      const insight = generateInsight({
        fullName: state.profile.fullName ?? null,
        intent: state.intent ?? null,
        desiredFeeling: state.profile.desiredFeeling ?? null,
        coreDesire: state.profile.coreDesire ?? null,
      });
      state.validation.lastInsight = insight;
      return { oriInsight: insight };
    }

    case "commitment":
    case "commitment_retry": {
      const howWeHelp = generateHowWeHelp({ intent: state.intent ?? null });
      return { howWeHelp };
    }

    case "discovery": {
      const seed = hashStringToSeed(state.entityId);
      const domain =
        state.intent === "love"
          ? "love"
          : state.intent === "friendship"
            ? "friendship"
            : state.intent === "business"
              ? "business"
              : undefined;
      const questions = pickDiscoveryQuestions(3, seed, domain);
      const first = questions[0];
      const second = questions[1];
      const third = questions[2];
      return {
        discoveryQuestion1Id: first?.id ?? null,
        discoveryQuestion1Theme: first?.theme ?? null,
        discoveryQuestion1Text: first?.text ?? null,
        discoveryQuestion2Id: second?.id ?? null,
        discoveryQuestion2Theme: second?.theme ?? null,
        discoveryQuestion2Text: second?.text ?? null,
        discoveryQuestion3Id: third?.id ?? null,
        discoveryQuestion3Theme: third?.theme ?? null,
        discoveryQuestion3Text: third?.text ?? null,
      };
    }
    case "profile":
      return {
        intent: state.intent ?? null,
      };

    default:
      return {};
  }
}

function getStageTransitionMessage(
  state: UserFlowState,
  stage: UserStage,
): string {
  const name = state.profile.fullName ?? "friend";

  switch (stage) {
    case "verification":
      return "I just sent a verification code. Please reply with it to continue.";
    case "deeper":
      return `Nice to meet you, ${name}. Now let's go a little deeper.`;
    case "validation":
      return "Let me make sure I understand you.";
    case "validation_retry":
      return "I want to get this right. Let me try again.";
    case "profile":
      return "Now the easy part. Tell me a bit more about yourself.";
    case "discovery":
      return "I have a few questions that will help me find the right people for you.";
    case "commitment":
      return "I think I have enough to get started.";
    case "commitment_retry":
      return "I understand. Take your time. When you're ready, we'll continue.";
    case "availability":
      return "Last thing. I need to know when you're free so I can set up meetings.";
    case "matching_queue":
      return `${name}, you're in. I'll start looking for people who might be a good fit. I'll reach out when I have someone worth your time. If you ever need support, text FLAG.`;
    case "group_meeting":
      if (
        state.groupMeeting.status === "scheduled" &&
        state.groupMeeting.scheduledAt
      ) {
        const timeZone = state.profile.timeZone;
        const when = formatMeetingTime(
          state.groupMeeting.scheduledAt,
          timeZone,
        );
        return `Before I match you 1:1, I'd like to invite you to a small group introduction. I have you down for ${when}. Reply DONE after you attend.`;
      }
      return "Before I match you 1:1, I'd like to invite you to a small group introduction. I'll send details soon.";
    case "active":
      return "You're all set. I'll be in touch when I find someone interesting.";
    default:
      return "";
  }
}

const GHOST_COOLOFF_DAYS = 60;
const MAX_GHOSTS_BEFORE_COOLOFF = 3;
const MAX_LATE_CANCELS_BEFORE_PENALTY = 2;

async function recordGhost(
  state: UserFlowState,
): Promise<{ cooloff: boolean; message: string }> {
  state.ghostCount += 1;
  state.reliability.ghostCount += 1;
  state.reliability.noShowCount += 1;
  recalculateReliabilityScore(state);
  await saveUserState(state);

  if (state.ghostCount >= MAX_GHOSTS_BEFORE_COOLOFF) {
    state.stage = "cooloff";
    state.cooloffUntil = Date.now() + GHOST_COOLOFF_DAYS * 24 * 60 * 60 * 1000;
    await saveUserState(state);
    return {
      cooloff: true,
      message: `I noticed you've missed a few meetings. Let's take a break for a couple months. I'll check in with you in ${GHOST_COOLOFF_DAYS} days. When you're ready to try again, just reach out.`,
    };
  }

  if (state.ghostCount === 1) {
    return {
      cooloff: false,
      message:
        "I noticed you missed the meeting. It happens. I'll find you another match.",
    };
  }

  return {
    cooloff: false,
    message: `I noticed you've missed a couple meetings. I understand life gets busy. Let's make sure the next one works better for your schedule.`,
  };
}

async function recordLateCancel(
  state: UserFlowState,
): Promise<{ penalty: boolean; message: string }> {
  state.lateCancelCount += 1;
  state.reliability.lateCancelCount += 1;
  recalculateReliabilityScore(state);
  await saveUserState(state);

  if (state.lateCancelCount >= MAX_LATE_CANCELS_BEFORE_PENALTY) {
    return {
      penalty: true,
      message:
        "I've noticed a pattern of last-minute cancellations. I'll lower your priority in the matching queue until your schedule is more stable.",
    };
  }

  return {
    penalty: false,
    message: "Got it. I'll let them know and see if we can reschedule.",
  };
}

async function recordAttendance(state: UserFlowState): Promise<void> {
  state.reliability.attendedCount += 1;
  // Decay ghost count over time with successful attendance
  if (state.ghostCount > 0 && state.reliability.attendedCount % 3 === 0) {
    state.ghostCount = Math.max(0, state.ghostCount - 1);
  }
  recalculateReliabilityScore(state);
  await saveUserState(state);
}

function recalculateReliabilityScore(state: UserFlowState): void {
  const { attendedCount, noShowCount, lateCancelCount } = state.reliability;
  const totalEvents = attendedCount + noShowCount + lateCancelCount;

  if (totalEvents === 0) {
    state.reliability.score = 1.0;
    return;
  }

  // Base score on attendance rate
  const attendanceRate = attendedCount / totalEvents;

  // Penalties for issues
  const noShowPenalty = noShowCount * 0.1;
  const lateCancelPenalty = lateCancelCount * 0.05;

  state.reliability.score = Math.max(
    0,
    Math.min(1, attendanceRate - noShowPenalty - lateCancelPenalty),
  );
}

const normalizeText = (value: string | undefined): string =>
  value?.trim().toLowerCase() ?? "";

const parseYesNo = (text: string): "yes" | "no" | null => {
  const normalized = normalizeText(text);
  if (normalized === "yes" || normalized.startsWith("yes ")) return "yes";
  if (normalized === "no" || normalized.startsWith("no ")) return "no";
  if (normalized === "y" || normalized === "yeah" || normalized === "yep")
    return "yes";
  if (normalized === "n" || normalized === "nope") return "no";
  return null;
};

const parseRating = (text: string): number | null => {
  const match = text.match(/\b([1-5])\b/);
  if (!match) return null;
  const rating = Number(match[1]);
  return Number.isFinite(rating) ? rating : null;
};

const latestMeetingId = (state: UserFlowState): string | null =>
  state.activeMeetingIds.length > 0
    ? state.activeMeetingIds[state.activeMeetingIds.length - 1]
    : null;

export const flowContextProvider: Provider = {
  name: "SOULMATES_FLOW_CONTEXT",
  description:
    "Provides context about user's position in the Soulmates onboarding flow",
  get: async (
    runtime: IAgentRuntime,
    message: Memory,
  ): Promise<ProviderResult> => {
    // Ensure runtime is set for storage operations
    setRuntime(runtime);

    const entityId = message.entityId;
    if (!entityId) {
      return { text: "" };
    }

    const phoneNumber =
      typeof message.content?.phoneNumber === "string"
        ? message.content.phoneNumber
        : undefined;
    await touchUserState(entityId, phoneNumber);

    const state = await getUserState(entityId);
    if (!state) {
      return {
        text: `<soulmates_flow>
User has not started onboarding. Greet them and start the intake process.
</soulmates_flow>`,
      };
    }

    const sections: string[] = [];
    sections.push(`Stage: ${state.stage}`);

    if (state.profile.fullName) {
      sections.push(`Name: ${state.profile.fullName}`);
    }
    if (state.intent) {
      sections.push(`Looking for: ${state.intent}`);
    }
    if (state.profile.city) {
      sections.push(`Location: ${state.profile.city}`);
    }
    if (state.profile.desiredFeeling) {
      sections.push(`Wants to feel: ${state.profile.desiredFeeling}`);
    }
    if (state.profile.coreDesire) {
      sections.push(`Core desire: ${state.profile.coreDesire}`);
    }

    // Reliability info
    if (state.reliability.score < 1.0) {
      sections.push(
        `Reliability score: ${(state.reliability.score * 100).toFixed(0)}%`,
      );
    }
    if (state.ghostCount > 0) {
      sections.push(`Ghost count: ${state.ghostCount}`);
    }

    // Stage-specific guidance
    let guidance = "";
    switch (state.stage) {
      case "entry":
        guidance = "Collect their name and location.";
        break;
      case "deeper":
        guidance = "Ask how they want to feel and what they really want.";
        break;
      case "validation":
        guidance =
          "Reflect back what you've learned and ask if you got it right.";
        break;
      case "validation_retry":
        guidance =
          "You got something wrong. Listen to their correction and try again.";
        break;
      case "profile":
        guidance =
          "Collect demographics: age, gender, orientation (if love), values.";
        break;
      case "discovery":
        guidance =
          "Ask deeper questions to understand their personality and needs.";
        break;
      case "commitment":
        guidance = "Explain how you can help and ask for their commitment.";
        break;
      case "availability":
        guidance =
          "Collect their scheduling preferences: timezone, preferred days/times, cadence.";
        break;
      case "matching_queue":
        guidance =
          "User is waiting for matches. Keep them engaged with occasional check-ins.";
        break;
      case "active":
        guidance =
          "User is active. Help with scheduling, reminders, and feedback.";
        break;
      case "paused":
        guidance =
          "User has paused. Respect their space but offer to restart when ready.";
        break;
      case "cooloff":
        guidance = `User is in cooloff period until ${new Date(state.cooloffUntil!).toLocaleDateString()}. Be understanding.`;
        break;
    }

    sections.push(`Guidance: ${guidance}`);

    return {
      text: `<soulmates_flow>\n${sections.join("\n")}\n</soulmates_flow>`,
    };
  },
};

const pauseMatchingAction: Action = {
  name: "PAUSE_MATCHING",
  similes: ["PAUSE", "TAKE_BREAK", "STOP_MATCHING"],
  description: "Pause the matching process",
  validate: async (_runtime, message) => {
    const text = message.content?.text?.toLowerCase() ?? "";
    const entityId = message.entityId;
    if (entityId) {
      const state = await getUserState(entityId);
      if (state?.checkIn.pendingDecision === "pause_or_skip") {
        return false;
      }
    }
    return (
      text.includes("pause") ||
      text.includes("break") ||
      text.includes("stop") ||
      text.includes("hold off")
    );
  },
  handler: async (runtime, message, _state, _options, callback) => {
    setRuntime(runtime);
    const entityId = message.entityId;
    if (!entityId) {
      return { success: false };
    }

    const userState = await getUserState(entityId);
    if (!userState) {
      await callback?.({
        text: "I don't have you in my records yet. Want to get started?",
      });
      return { success: false };
    }

    if (userState.stage === "paused") {
      await callback?.({
        text: "You're already on pause. Just let me know when you're ready to start again.",
      });
      return { success: true };
    }

    userState.stage = "paused";
    userState.pausedAt = Date.now();
    userState.checkIn.status = "paused";
    userState.checkIn.pendingDecision = undefined;
    await saveUserState(userState);
    await syncPersona(runtime, userState);

    await callback?.({
      text: "I've paused your matching. Take the time you need. Just say 'ready' when you want to jump back in.",
    });

    return { success: true };
  },
  examples: [],
};

const resumeMatchingAction: Action = {
  name: "RESUME_MATCHING",
  similes: ["RESUME", "UNPAUSE", "START_AGAIN", "READY"],
  description: "Resume the matching process after a pause",
  validate: async (_runtime, message) => {
    const text = message.content?.text?.toLowerCase() ?? "";
    return (
      text.includes("resume") ||
      text.includes("ready") ||
      text.includes("start again") ||
      text.includes("unpause") ||
      text.includes("back")
    );
  },
  handler: async (runtime, message, _state, _options, callback) => {
    setRuntime(runtime);
    const entityId = message.entityId;
    if (!entityId) {
      return { success: false };
    }

    const userState = await getUserState(entityId);
    if (!userState) {
      await callback?.({
        text: "I don't have you in my records yet. Want to get started?",
      });
      return { success: false };
    }

    if (userState.stage === "cooloff") {
      if (userState.cooloffUntil && userState.cooloffUntil > Date.now()) {
        const daysLeft = Math.ceil(
          (userState.cooloffUntil - Date.now()) / (24 * 60 * 60 * 1000),
        );
        await callback?.({
          text: `You're in a cooloff period for ${daysLeft} more days. I'll reach out when it's over.`,
        });
        return { success: false };
      }
    }

    if (userState.stage !== "paused" && userState.stage !== "cooloff") {
      await callback?.({
        text: "You're not paused. I'm still working on finding you matches.",
      });
      return { success: true };
    }

    userState.stage = "active";
    userState.pausedAt = undefined;
    userState.cooloffUntil = undefined;
    userState.checkIn.status = "idle";
    userState.checkIn.pendingDecision = undefined;
    await saveUserState(userState);
    await syncPersona(runtime, userState);

    await callback?.({
      text: "Welcome back. I'll start looking for new matches for you right away.",
    });

    return { success: true };
  },
  examples: [],
};

const getMatchingService = (runtime: IAgentRuntime): MatchingService | null =>
  runtime.getService<MatchingService>("SOULMATES_MATCHING");

const syncPersona = async (
  runtime: IAgentRuntime,
  state: UserFlowState,
): Promise<void> => {
  const matchingService = getMatchingService(runtime);
  if (!matchingService) return;
  await matchingService.addOrUpdatePersona(state.entityId, state);
};

const checkInYesAction: Action = {
  name: "CHECKIN_YES",
  similes: ["CHECKIN_YES", "READY_TO_MEET"],
  description: "User opted in to be matched in the current check-in cycle",
  validate: async (_runtime, message) => {
    const entityId = message.entityId;
    if (!entityId) return false;
    const state = await getUserState(entityId);
    if (!state || state.checkIn.status !== "pending") return false;
    const response = parseYesNo(message.content?.text ?? "");
    return response === "yes";
  },
  handler: async (runtime, message, _state, _options, callback) => {
    setRuntime(runtime);
    const entityId = message.entityId;
    if (!entityId) return { success: false };
    const state = await getUserState(entityId);
    if (!state) return { success: false };

    state.checkIn.status = "idle";
    state.checkIn.pendingDecision = undefined;
    state.checkIn.lastResponseAt = Date.now();
    if (state.stage === "matching_queue") {
      state.stage = "active";
    }
    await saveUserState(state);
    await syncPersona(runtime, state);

    const matchingService = getMatchingService(runtime);
    if (matchingService) {
      await matchingService.runMatchingTick();
    }

    await callback?.({
      text: "Perfect. I am on it and will reach out when I find someone worth your time.",
    });
    return { success: true };
  },
  examples: [],
};

const checkInNoAction: Action = {
  name: "CHECKIN_NO",
  similes: ["CHECKIN_NO", "NOT_THIS_TIME"],
  description: "User declined the current check-in cycle",
  validate: async (_runtime, message) => {
    const entityId = message.entityId;
    if (!entityId) return false;
    const state = await getUserState(entityId);
    if (!state || state.checkIn.status !== "pending") return false;
    const response = parseYesNo(message.content?.text ?? "");
    return response === "no";
  },
  handler: async (runtime, message, _state, _options, callback) => {
    setRuntime(runtime);
    const entityId = message.entityId;
    if (!entityId) return { success: false };
    const state = await getUserState(entityId);
    if (!state) return { success: false };

    state.checkIn.pendingDecision = "pause_or_skip";
    state.checkIn.lastResponseAt = Date.now();
    await saveUserState(state);

    await callback?.({
      text: "Got it. Would you like to pause for a month or just skip this round? Reply PAUSE or SKIP.",
    });
    return { success: true };
  },
  examples: [],
};

const checkInLaterAction: Action = {
  name: "CHECKIN_LATER",
  similes: ["CHECKIN_LATER", "CHECKIN_REMIND_ME"],
  description: "User asked to be reminded later",
  validate: async (_runtime, message) => {
    const entityId = message.entityId;
    if (!entityId) return false;
    const state = await getUserState(entityId);
    if (!state || state.checkIn.status !== "pending") return false;
    const text = normalizeText(message.content?.text);
    return text.includes("later") || text.includes("remind");
  },
  handler: async (runtime, message, _state, _options, callback) => {
    setRuntime(runtime);
    const entityId = message.entityId;
    if (!entityId) return { success: false };
    const state = await getUserState(entityId);
    if (!state) return { success: false };

    const delayHours = Number(
      process.env.SOULMATES_CHECKIN_LATER_HOURS ?? "12",
    );
    const delayMs = Number.isFinite(delayHours)
      ? delayHours * 60 * 60 * 1000
      : 12 * 60 * 60 * 1000;
    state.checkIn.status = "paused";
    state.checkIn.pendingDecision = "later";
    state.checkIn.lastResponseAt = Date.now();
    state.checkIn.nextCheckInAt = Date.now() + delayMs;
    await saveUserState(state);

    await callback?.({
      text: "No problem. I will check back in a bit.",
    });
    return { success: true };
  },
  examples: [],
};

const checkInSkipAction: Action = {
  name: "CHECKIN_SKIP",
  similes: ["CHECKIN_SKIP", "SKIP_MATCHING"],
  description: "User skipped the current check-in cycle",
  validate: async (_runtime, message) => {
    const entityId = message.entityId;
    if (!entityId) return false;
    const state = await getUserState(entityId);
    if (!state || state.checkIn.pendingDecision !== "pause_or_skip")
      return false;
    const text = normalizeText(message.content?.text);
    return text.includes("skip");
  },
  handler: async (runtime, message, _state, _options, callback) => {
    setRuntime(runtime);
    const entityId = message.entityId;
    if (!entityId) return { success: false };
    const state = await getUserState(entityId);
    if (!state) return { success: false };

    const skipDays = Number(process.env.SOULMATES_CHECKIN_SKIP_DAYS ?? "7");
    const skipMs = Number.isFinite(skipDays)
      ? skipDays * 24 * 60 * 60 * 1000
      : 7 * 24 * 60 * 60 * 1000;
    state.checkIn.status = "idle";
    state.checkIn.pendingDecision = undefined;
    state.checkIn.nextCheckInAt = Date.now() + skipMs;
    await saveUserState(state);

    await callback?.({
      text: "Understood. I will skip this round and check back in later.",
    });
    return { success: true };
  },
  examples: [],
};

const checkInPauseAction: Action = {
  name: "CHECKIN_PAUSE",
  similes: ["CHECKIN_PAUSE", "PAUSE_CYCLE"],
  description: "User paused matching for a month after check-in",
  validate: async (_runtime, message) => {
    const entityId = message.entityId;
    if (!entityId) return false;
    const state = await getUserState(entityId);
    if (!state || state.checkIn.pendingDecision !== "pause_or_skip")
      return false;
    const text = normalizeText(message.content?.text);
    return text.includes("pause");
  },
  handler: async (runtime, message, _state, _options, callback) => {
    setRuntime(runtime);
    const entityId = message.entityId;
    if (!entityId) return { success: false };
    const state = await getUserState(entityId);
    if (!state) return { success: false };

    const pauseDays = Number(process.env.SOULMATES_CHECKIN_PAUSE_DAYS ?? "30");
    const pauseMs = Number.isFinite(pauseDays)
      ? pauseDays * 24 * 60 * 60 * 1000
      : 30 * 24 * 60 * 60 * 1000;
    state.checkIn.status = "paused";
    state.checkIn.pendingDecision = undefined;
    state.checkIn.nextCheckInAt = Date.now() + pauseMs;
    state.pausedAt = Date.now();
    await saveUserState(state);

    await callback?.({
      text: "Got it. I will pause for a month and check back in when you are ready.",
    });
    return { success: true };
  },
  examples: [],
};

const resendVerificationAction: Action = {
  name: "RESEND_VERIFICATION",
  similes: ["RESEND_CODE", "RESEND", "NEW_CODE"],
  description: "Resend verification code during onboarding",
  validate: async (_runtime, message) => {
    const entityId = message.entityId;
    if (!entityId) return false;
    const state = await getUserState(entityId);
    if (!state || state.stage !== "verification") return false;
    const text = normalizeText(message.content?.text);
    return text.includes("resend") || text.includes("code");
  },
  handler: async (runtime, message, _state, _options, callback) => {
    setRuntime(runtime);
    const entityId = message.entityId;
    const roomId = message.roomId;
    if (!entityId || !roomId) return { success: false };
    const state = await getUserState(entityId);
    if (!state) return { success: false };

    await issueVerificationCode(runtime, state, roomId);
    await callback?.({
      text: "I just sent a new code. Please reply with it to continue.",
    });
    return { success: true };
  },
  examples: [],
};

const confirmMeetingAction: Action = {
  name: "CONFIRM_MEETING",
  similes: ["CONFIRM_MEETING", "MEETING_YES"],
  description: "User confirmed a proposed meeting time",
  validate: async (_runtime, message) => {
    const entityId = message.entityId;
    if (!entityId) return false;
    const state = await getUserState(entityId);
    if (!state?.pendingMeetingConfirmation) return false;
    const response = parseYesNo(message.content?.text ?? "");
    return response === "yes";
  },
  handler: async (runtime, message, _state, _options, callback) => {
    setRuntime(runtime);
    const entityId = message.entityId;
    if (!entityId) return { success: false };
    const state = await getUserState(entityId);
    if (!state?.pendingMeetingConfirmation) return { success: false };

    const matchingService = getMatchingService(runtime);
    if (matchingService) {
      await matchingService.confirmMeeting(
        state.pendingMeetingConfirmation,
        entityId,
      );
    }
    if (!state.activeMeetingIds.includes(state.pendingMeetingConfirmation)) {
      state.activeMeetingIds.push(state.pendingMeetingConfirmation);
    }
    state.pendingMeetingConfirmation = undefined;
    state.pendingMeetingConfirmationAt = undefined;
    state.pendingMeetingEscalatedAt = undefined;
    await saveUserState(state);

    await callback?.({
      text: "Locked in. I will remind you 24 hours and 2 hours before the meeting.",
    });
    return { success: true };
  },
  examples: [],
};

const declineMeetingAction: Action = {
  name: "DECLINE_MEETING",
  similes: ["DECLINE_MEETING", "MEETING_NO"],
  description: "User declined the proposed meeting time",
  validate: async (_runtime, message) => {
    const entityId = message.entityId;
    if (!entityId) return false;
    const state = await getUserState(entityId);
    if (!state?.pendingMeetingConfirmation) return false;
    const response = parseYesNo(message.content?.text ?? "");
    return response === "no";
  },
  handler: async (runtime, message, _state, _options, callback) => {
    setRuntime(runtime);
    const entityId = message.entityId;
    if (!entityId) return { success: false };
    const state = await getUserState(entityId);
    if (!state?.pendingMeetingConfirmation) return { success: false };

    state.pendingMeetingConfirmation = undefined;
    state.pendingMeetingConfirmationAt = undefined;
    state.pendingMeetingEscalatedAt = undefined;
    await saveUserState(state);

    await callback?.({
      text: "No problem. Reply MOVE to propose a new time or CANCEL to drop this meeting.",
    });
    return { success: true };
  },
  examples: [],
};

const moveMeetingAction: Action = {
  name: "MOVE_MEETING",
  similes: ["MOVE", "RESCHEDULE_MEETING"],
  description: "User requested a meeting reschedule",
  validate: async (_runtime, message) => {
    const entityId = message.entityId;
    if (!entityId) return false;
    const state = await getUserState(entityId);
    if (!state) return false;
    const text = normalizeText(message.content?.text);
    return text.includes("move") || text.includes("reschedule");
  },
  handler: async (runtime, message, _state, _options, callback) => {
    setRuntime(runtime);
    const entityId = message.entityId;
    if (!entityId) return { success: false };
    const state = await getUserState(entityId);
    if (!state) return { success: false };

    const meetingId =
      state.pendingMeetingConfirmation ?? latestMeetingId(state);
    if (!meetingId) {
      await callback?.({ text: "I do not have a meeting to move right now." });
      return { success: false };
    }

    const matchingService = getMatchingService(runtime);
    if (!matchingService) return { success: false };
    const rescheduled = await matchingService.rescheduleMeeting(
      meetingId,
      entityId,
    );
    if (!rescheduled) {
      await callback?.({
        text: "I could not find another slot yet. I will have a human help schedule this.",
      });
      return { success: true };
    }

    state.pendingMeetingConfirmation = rescheduled.meetingId;
    state.pendingMeetingConfirmationAt = Date.now();
    state.pendingMeetingEscalatedAt = undefined;
    if (!state.activeMeetingIds.includes(rescheduled.meetingId)) {
      state.activeMeetingIds.push(rescheduled.meetingId);
    }
    await saveUserState(state);

    await callback?.({
      text: `Here is a new proposal: ${rescheduled.timeText}. Reply YES to confirm or MOVE to adjust.`,
    });
    return { success: true };
  },
  examples: [],
};

const cancelMeetingAction: Action = {
  name: "CANCEL_MEETING",
  similes: ["CANCEL", "CALL_OFF_MEETING"],
  description: "User requested meeting cancellation",
  validate: async (_runtime, message) => {
    const entityId = message.entityId;
    if (!entityId) return false;
    const state = await getUserState(entityId);
    if (!state) return false;
    const text = normalizeText(message.content?.text);
    return text.includes("cancel");
  },
  handler: async (runtime, message, _state, _options, callback) => {
    setRuntime(runtime);
    const entityId = message.entityId;
    if (!entityId) return { success: false };
    const state = await getUserState(entityId);
    if (!state) return { success: false };

    const meetingId =
      state.pendingMeetingConfirmation ?? latestMeetingId(state);
    if (!meetingId) {
      await callback?.({
        text: "I do not have a meeting to cancel right now.",
      });
      return { success: false };
    }

    const matchingService = getMatchingService(runtime);
    if (!matchingService) return { success: false };
    const cancelInfo = await matchingService.getCancellationInfo(
      meetingId,
      entityId,
    );
    if (cancelInfo.requiresConfirm) {
      state.pendingCancel = { meetingId, requestedAt: Date.now() };
      await saveUserState(state);
      await callback?.({
        text: "This meeting is very close. Reply CONFIRM to cancel or MOVE to reschedule.",
      });
      return { success: true };
    }

    await matchingService.cancelMeeting(meetingId, entityId);
    state.pendingMeetingConfirmation = undefined;
    state.pendingMeetingConfirmationAt = undefined;
    state.pendingMeetingEscalatedAt = undefined;
    if (cancelInfo.isLate) {
      const response = await recordLateCancel(state);
      await syncPersona(runtime, state);
      await callback?.({ text: response.message });
    } else {
      await callback?.({ text: "Understood. I have canceled it." });
    }
    return { success: true };
  },
  examples: [],
};

const confirmCancelAction: Action = {
  name: "CONFIRM_CANCEL",
  similes: ["CONFIRM_CANCEL", "CONFIRM_CANCELLATION"],
  description: "User confirmed last-minute cancellation",
  validate: async (_runtime, message) => {
    const entityId = message.entityId;
    if (!entityId) return false;
    const state = await getUserState(entityId);
    if (!state?.pendingCancel) return false;
    const text = normalizeText(message.content?.text);
    return text.includes("confirm");
  },
  handler: async (runtime, message, _state, _options, callback) => {
    setRuntime(runtime);
    const entityId = message.entityId;
    if (!entityId) return { success: false };
    const state = await getUserState(entityId);
    if (!state?.pendingCancel) return { success: false };

    const meetingId = state.pendingCancel.meetingId;
    state.pendingCancel = undefined;
    state.pendingMeetingConfirmation = undefined;
    state.pendingMeetingConfirmationAt = undefined;
    state.pendingMeetingEscalatedAt = undefined;
    await saveUserState(state);

    const matchingService = getMatchingService(runtime);
    if (!matchingService) return { success: false };
    await matchingService.cancelMeeting(meetingId, entityId);
    const response = await recordLateCancel(state);
    await syncPersona(runtime, state);
    await callback?.({ text: response.message });
    return { success: true };
  },
  examples: [],
};

const introMatchAction: Action = {
  name: "INTRO_MATCH",
  similes: ["INTRO", "INTRODUCE"],
  description: "User requested a warm introduction to their match",
  validate: async (_runtime, message) => {
    const entityId = message.entityId;
    if (!entityId) return false;
    const state = await getUserState(entityId);
    if (!state?.pendingIntroMatchId) return false;
    const text = normalizeText(message.content?.text);
    return text.includes("intro") || text.includes("introduce");
  },
  handler: async (runtime, message, _state, _options, callback) => {
    setRuntime(runtime);
    const entityId = message.entityId;
    if (!entityId) return { success: false };
    const state = await getUserState(entityId);
    if (!state?.pendingIntroMatchId) return { success: false };

    const matchingService = getMatchingService(runtime);
    if (matchingService) {
      await matchingService.sendWarmIntro(state.pendingIntroMatchId, entityId);
    }
    state.pendingIntroMatchId = undefined;
    await saveUserState(state);

    await callback?.({ text: "Done. I made the intro." });
    return { success: true };
  },
  examples: [],
};

const feedbackResponseAction: Action = {
  name: "SUBMIT_FEEDBACK",
  similes: ["MEETING_FEEDBACK", "RATE_MEETING"],
  description: "Handle post-meeting feedback responses",
  validate: async (_runtime, message) => {
    const entityId = message.entityId;
    if (!entityId) return false;
    const state = await getUserState(entityId);
    return Boolean(state?.pendingFeedback);
  },
  handler: async (runtime, message, _state, _options, callback) => {
    setRuntime(runtime);
    const entityId = message.entityId;
    if (!entityId) return { success: false };
    const state = await getUserState(entityId);
    if (!state?.pendingFeedback) return { success: false };

    const text = message.content?.text ?? "";
    const feedback = state.pendingFeedback;

    if (feedback.stage === "rating") {
      const rating = parseRating(text);
      if (!rating) {
        await callback?.({ text: "Please reply with a rating from 1 to 5." });
        return { success: true };
      }
      feedback.rating = rating;
      feedback.sentiment =
        rating >= 4 ? "positive" : rating <= 2 ? "negative" : "neutral";
      feedback.stage = "meet_again";
      await saveUserState(state);
      await callback?.({
        text: "Would you like to meet them again? Reply YES or NO.",
      });
      return { success: true };
    }

    if (feedback.stage === "meet_again") {
      const response = parseYesNo(text);
      if (!response) {
        await callback?.({ text: "Please reply YES or NO." });
        return { success: true };
      }
      feedback.meetAgain = response === "yes";
      if (feedback.sentiment === "negative") {
        feedback.stage = "notes";
        await saveUserState(state);
        await callback?.({
          text: "I am sorry to hear that. Can you share what went wrong?",
        });
        return { success: true };
      }
      feedback.stage = "complete";
    }

    if (feedback.stage === "notes") {
      feedback.notes = text.trim();
      feedback.stage = "complete";
    }

    const matchingService = getMatchingService(runtime);
    if (
      matchingService &&
      feedback.stage === "complete" &&
      typeof feedback.rating === "number" &&
      typeof feedback.meetAgain === "boolean" &&
      feedback.sentiment
    ) {
      await matchingService.recordFeedback(entityId, {
        meetingId: feedback.meetingId,
        rating: feedback.rating,
        sentiment: feedback.sentiment,
        meetAgain: feedback.meetAgain,
        notes: feedback.notes,
      });
    }
    state.pendingFeedback = undefined;
    await saveUserState(state);
    await callback?.({
      text: "Thank you. Your feedback helps me make better matches.",
    });
    return { success: true };
  },
  examples: [],
};

const discoveryResponseAction: Action = {
  name: "DISCOVERY_ANSWER",
  similes: ["DISCOVERY_ANSWER", "INSIGHT_ANSWER"],
  description: "Capture a progressive profiling response",
  validate: async (_runtime, message) => {
    const entityId = message.entityId;
    if (!entityId) return false;
    const state = await getUserState(entityId);
    if (!state?.pendingDiscoveryQuestion) return false;
    const text = normalizeText(message.content?.text);
    if (!text) return false;
    return !["yes", "no", "y", "n"].includes(text);
  },
  handler: async (runtime, message, _state, _options, callback) => {
    setRuntime(runtime);
    const entityId = message.entityId;
    if (!entityId) return { success: false };
    const state = await getUserState(entityId);
    if (!state?.pendingDiscoveryQuestion) return { success: false };

    const answer = message.content?.text?.trim();
    if (!answer) return { success: false };
    const normalized = normalizeText(answer);
    if (normalized.includes("skip") || normalized.includes("pass")) {
      state.pendingDiscoveryQuestion = undefined;
      await saveUserState(state);
      await callback?.({ text: "No problem. We can skip that for now." });
      return { success: true };
    }

    if (!state.profile.discoveryAnswers) {
      state.profile.discoveryAnswers = [];
    }
    state.profile.discoveryAnswers.push({
      questionId: state.pendingDiscoveryQuestion.questionId,
      theme: state.pendingDiscoveryQuestion.theme,
      question: state.pendingDiscoveryQuestion.question,
      answer,
    });
    state.pendingDiscoveryQuestion = undefined;
    await saveUserState(state);
    await syncPersona(runtime, state);

    await callback?.({
      text: "Thank you. That helps me understand you better.",
    });
    return { success: true };
  },
  examples: [],
};

const runningLateAction: Action = {
  name: "RUNNING_LATE",
  similes: ["LATE", "RUNNING_LATE"],
  description: "Notify the match partner about a late arrival",
  validate: async (_runtime, message) => {
    const entityId = message.entityId;
    if (!entityId) return false;
    const text = normalizeText(message.content?.text);
    return text.includes("late");
  },
  handler: async (runtime, message, _state, _options, callback) => {
    setRuntime(runtime);
    const entityId = message.entityId;
    if (!entityId) return { success: false };
    const state = await getUserState(entityId);
    if (!state) return { success: false };
    const meetingId = latestMeetingId(state);
    if (!meetingId) {
      await callback?.({ text: "I cannot find an active meeting to update." });
      return { success: false };
    }

    const matchingService = getMatchingService(runtime);
    if (!matchingService) return { success: false };
    const partnerId = await matchingService.getMeetingPartnerEntity(
      meetingId,
      entityId,
    );
    if (!partnerId) return { success: false };

    const partnerState = await getUserState(partnerId);
    const partnerPhone = partnerState?.phoneNumber;
    if (!partnerPhone) return { success: false };

    const twilio = runtime.getService<SmsService>("twilio");
    if (!twilio) return { success: false };
    const name = state.profile.fullName ?? "Your match";
    await twilio.sendSms(
      partnerPhone,
      `${name} is running a bit late but is on the way.`,
    );

    await callback?.({
      text: "Thanks for letting me know. I told them you are running late.",
    });
    return { success: true };
  },
  examples: [],
};

const groupMeetingDoneAction: Action = {
  name: "GROUP_MEETING_DONE",
  similes: ["GROUP_DONE", "ATTENDED_GROUP"],
  description: "User confirmed group meeting attendance",
  validate: async (_runtime, message) => {
    const entityId = message.entityId;
    if (!entityId) return false;
    const state = await getUserState(entityId);
    if (!state || state.stage !== "group_meeting") return false;
    const text = normalizeText(message.content?.text);
    return text.includes("done") || text.includes("attended");
  },
  handler: async (runtime, message, _state, _options, callback) => {
    setRuntime(runtime);
    const entityId = message.entityId;
    if (!entityId) return { success: false };
    const state = await getUserState(entityId);
    if (!state) return { success: false };

    state.groupMeeting.status = "completed";
    state.groupMeeting.completedAt = Date.now();
    state.stage = "active";
    await saveUserState(state);
    await syncPersona(runtime, state);

    await callback?.({
      text: "Thanks for joining. I will move you into active matching now.",
    });
    return { success: true };
  },
  examples: [],
};

const groupMeetingRatingAction: Action = {
  name: "GROUP_MEETING_RATING",
  similes: ["GROUP_RATING", "RATE_GROUP"],
  description: "User provided rating for group meeting",
  validate: async (_runtime, message) => {
    const entityId = message.entityId;
    if (!entityId) return false;
    const state = await getUserState(entityId);
    if (!state || state.stage !== "group_meeting") return false;
    if (!state.groupMeeting?.feedbackRequestedAt) return false;
    const text = normalizeText(message.content?.text);
    const ratingMatch = text.match(/[1-5]/);
    return !!ratingMatch;
  },
  handler: async (runtime, message, _state, _options, callback) => {
    setRuntime(runtime);
    const entityId = message.entityId;
    if (!entityId) return { success: false };
    const state = await getUserState(entityId);
    if (!state) return { success: false };

    const text = normalizeText(message.content?.text);
    const ratingMatch = text.match(/[1-5]/);
    const rating = ratingMatch ? Number.parseInt(ratingMatch[0], 10) : 3;

    state.groupMeeting.reviewScore = rating;
    state.groupMeeting.validated = rating >= 3;

    if (state.groupMeeting.validated) {
      state.stage = "active";
      state.checkIn.status = "idle";
      state.checkIn.nextCheckInAt = Date.now();
      await saveUserState(state);
      await syncPersona(runtime, state);
      await callback?.({
        text: "Thanks for the feedback! You are now in the matching pool. I will check in soon to find you someone great.",
      });
    } else {
      await saveUserState(state);
      await callback?.({
        text: "Thanks for the feedback. I will check in later to see if you would like to try another group intro.",
      });
    }
    return { success: true };
  },
  examples: [],
};

const groupMeetingSkipAction: Action = {
  name: "GROUP_MEETING_SKIP",
  similes: ["SKIP_GROUP", "MISSED_GROUP"],
  description: "User skipped or missed group meeting",
  validate: async (_runtime, message) => {
    const entityId = message.entityId;
    if (!entityId) return false;
    const state = await getUserState(entityId);
    if (!state || state.stage !== "group_meeting") return false;
    const text = normalizeText(message.content?.text);
    return (
      text.includes("skip") ||
      text.includes("missed") ||
      text.includes("could not attend")
    );
  },
  handler: async (runtime, message, _state, _options, callback) => {
    setRuntime(runtime);
    const entityId = message.entityId;
    if (!entityId) return { success: false };
    const state = await getUserState(entityId);
    if (!state) return { success: false };

    // Reset to pending for next group meeting opportunity
    state.groupMeeting.status = "pending";
    state.groupMeeting.scheduledAt = undefined;
    state.groupMeeting.reminderSentAt = undefined;
    state.groupMeeting.feedbackRequestedAt = undefined;
    await saveUserState(state);

    await callback?.({
      text: "No worries. I will let you know about the next group intro opportunity.",
    });
    return { success: true };
  },
  examples: [],
};

const readyReactivationAction: Action = {
  name: "READY_REACTIVATION",
  similes: ["READY", "BACK", "REACTIVATE"],
  description: "User is ready to be reactivated from pause",
  validate: async (_runtime, message) => {
    const entityId = message.entityId;
    if (!entityId) return false;
    const state = await getUserState(entityId);
    if (!state) return false;
    if (state.stage !== "paused") return false;
    const text = normalizeText(message.content?.text);
    return (
      text.includes("ready") ||
      text.includes("back") ||
      text.includes("reactivate")
    );
  },
  handler: async (runtime, message, _state, _options, callback) => {
    setRuntime(runtime);
    const entityId = message.entityId;
    if (!entityId) return { success: false };
    const state = await getUserState(entityId);
    if (!state) return { success: false };

    state.stage = "active";
    state.pausedAt = undefined;
    state.checkIn.status = "idle";
    state.checkIn.nextCheckInAt = Date.now();
    state.reactivationAttempts = 0;
    state.lastReactivationAttemptAt = undefined;
    await saveUserState(state);
    await syncPersona(runtime, state);

    await callback?.({
      text: "Welcome back! I will start looking for a great match for you.",
    });
    return { success: true };
  },
  examples: [],
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

const flagSafetyAction: Action = {
  name: "FLAG_SAFETY",
  similes: ["FLAG", "REPORT", "UNSAFE"],
  description: "User requested safety support",
  validate: async (_runtime, message) => {
    const text = normalizeText(message.content?.text);
    return (
      text === "flag" || text.includes("unsafe") || text.includes("report")
    );
  },
  handler: async (runtime, message, _state, _options, callback) => {
    setRuntime(runtime);
    const entityId = message.entityId;
    if (!entityId) return { success: false };
    const matchingService = getMatchingService(runtime);
    const transcriptRef = message.id ?? message.content?.url;
    if (matchingService) {
      await matchingService.reportSafety(
        entityId,
        "level2",
        message.content?.text ?? "",
        transcriptRef,
      );
    }
    await notifyAdmin(
      runtime,
      `Safety FLAG from ${entityId}: ${message.content?.text ?? ""}`,
    );
    await callback?.({
      text: "I am here with you. I have flagged this for support and will follow up shortly.",
    });
    return { success: true };
  },
  examples: [],
};

const redSafetyAction: Action = {
  name: "RED_EMERGENCY",
  similes: ["RED", "EMERGENCY"],
  description: "User reported an emergency",
  validate: async (_runtime, message) => {
    const text = normalizeText(message.content?.text);
    return text === "red" || text.includes("emergency");
  },
  handler: async (runtime, message, _state, _options, callback) => {
    setRuntime(runtime);
    const entityId = message.entityId;
    if (!entityId) return { success: false };
    const matchingService = getMatchingService(runtime);
    const transcriptRef = message.id ?? message.content?.url;
    if (matchingService) {
      await matchingService.reportSafety(
        entityId,
        "level3",
        message.content?.text ?? "",
        transcriptRef,
      );
    }
    await notifyAdmin(
      runtime,
      `EMERGENCY RED from ${entityId}: ${message.content?.text ?? ""}`,
    );
    await callback?.({
      text: "I am here. If you are in immediate danger, contact local emergency services now. I have escalated this to the team.",
    });
    return { success: true };
  },
  examples: [],
};

const discomfortSafetyAction: Action = {
  name: "DISCOMFORT_SAFETY",
  similes: ["UNCOMFORTABLE", "DISCOMFORT", "NOT_OK"],
  description: "User reported discomfort or concern",
  validate: async (_runtime, message) => {
    const text = normalizeText(message.content?.text);
    return (
      text.includes("uncomfortable") ||
      text.includes("discomfort") ||
      text.includes("not ok")
    );
  },
  handler: async (runtime, message, _state, _options, callback) => {
    setRuntime(runtime);
    const entityId = message.entityId;
    if (!entityId) return { success: false };
    const matchingService = getMatchingService(runtime);
    const transcriptRef = message.id ?? message.content?.url;
    if (matchingService) {
      await matchingService.reportSafety(
        entityId,
        "level1",
        message.content?.text ?? "",
        transcriptRef,
      );
    }
    await callback?.({
      text: "Thanks for letting me know. I recorded this and will keep it in mind.",
    });
    return { success: true };
  },
  examples: [],
};

const blockMatchAction: Action = {
  name: "BLOCK_MATCH",
  similes: ["BLOCK", "BLOCK_MATCH"],
  description: "User blocked their current match",
  validate: async (_runtime, message) => {
    const entityId = message.entityId;
    if (!entityId) return false;
    const state = await getUserState(entityId);
    if (!state || state.activeMatchIds.length === 0) return false;
    const text = normalizeText(message.content?.text);
    return text.includes("block");
  },
  handler: async (runtime, message, _state, _options, callback) => {
    setRuntime(runtime);
    const entityId = message.entityId;
    if (!entityId) return { success: false };
    const state = await getUserState(entityId);
    if (!state) return { success: false };
    const matchId = state.activeMatchIds[state.activeMatchIds.length - 1];
    const matchingService = getMatchingService(runtime);
    if (matchingService) {
      await matchingService.blockMatch(matchId, entityId);
    }
    await callback?.({
      text: "Understood. I have blocked that match and will not reconnect you.",
    });
    return { success: true };
  },
  examples: [],
};

const onEntryCompleteWorker: TaskWorker = {
  name: "flow_entry_complete",
  execute: async (runtime: IAgentRuntime, options, task: Task) => {
    setRuntime(runtime);
    const values = options.values as Record<string, unknown>;
    const entityId = task.entityId;
    if (!entityId) return;

    const state = await getOrCreateUserState(entityId);
    state.profile.fullName = values.fullName as string;
    state.profile.city = values.city as string;
    state.intent = values.intent as Intent;
    await saveUserState(state);

    // Advance to deeper stage
    if (task.roomId) {
      await advanceStage(runtime, state, task.roomId);
    }
  },
};

const onDeeperCompleteWorker: TaskWorker = {
  name: "flow_deeper_complete",
  execute: async (runtime: IAgentRuntime, options, task: Task) => {
    setRuntime(runtime);
    const values = options.values as Record<string, unknown>;
    const entityId = task.entityId;
    if (!entityId) return;

    const state = await getUserState(entityId);
    if (!state) return;

    state.profile.desiredFeeling = values.desiredFeeling as string;
    state.profile.coreDesire = values.coreDesire as string;
    await saveUserState(state);

    // Advance to validation stage
    if (task.roomId) {
      await advanceStage(runtime, state, task.roomId);
    }
  },
};

const onValidationCompleteWorker: TaskWorker = {
  name: "flow_validation_complete",
  execute: async (runtime: IAgentRuntime, options, task: Task) => {
    setRuntime(runtime);
    const values = options.values as Record<string, unknown>;
    const entityId = task.entityId;
    if (!entityId) return;

    const state = await getUserState(entityId);
    if (!state) return;

    const insightCorrect = values.insightCorrect as string;
    const correction = values.correction as string | undefined;

    if (insightCorrect === "yes") {
      // Advance to profile stage
      if (task.roomId) {
        await advanceStage(runtime, state, task.roomId);
      }
    } else {
      // Go back for correction
      state.validationAttempts += 1;
      state.validation.correction = correction;
      state.stage = "validation_retry";
      await saveUserState(state);

      // Would need to regenerate insight incorporating correction
      // For now, just restart validation
      if (task.roomId) {
        await advanceStage(runtime, state, task.roomId);
      }
    }
  },
};

export const flowOrchestratorPlugin: Plugin = {
  name: "soulmates-flow-orchestrator",
  description: "Manages user lifecycle and onboarding flow for Soulmates",
  dependencies: ["form"],
  providers: [flowContextProvider],
  actions: [
    pauseMatchingAction,
    resumeMatchingAction,
    checkInYesAction,
    checkInNoAction,
    checkInLaterAction,
    checkInSkipAction,
    checkInPauseAction,
    resendVerificationAction,
    confirmMeetingAction,
    declineMeetingAction,
    moveMeetingAction,
    cancelMeetingAction,
    confirmCancelAction,
    introMatchAction,
    feedbackResponseAction,
    discoveryResponseAction,
    groupMeetingDoneAction,
    groupMeetingRatingAction,
    groupMeetingSkipAction,
    readyReactivationAction,
    runningLateAction,
    discomfortSafetyAction,
    flagSafetyAction,
    redSafetyAction,
    blockMatchAction,
  ],
  init: async (_config: Record<string, string>, runtime: IAgentRuntime) => {
    // Set runtime for storage operations
    setRuntime(runtime);

    // Register flow completion workers
    runtime.registerTaskWorker(onEntryCompleteWorker);
    runtime.registerTaskWorker(onDeeperCompleteWorker);
    runtime.registerTaskWorker(onValidationCompleteWorker);

    runtime.logger.info(
      "[FlowOrchestrator] Initialized with persistent storage",
    );
  },
};

// Export utilities
export {
  getUserState,
  saveUserState,
  getOrCreateUserState,
  listUserStates,
  touchUserState,
  advanceStage,
  recordGhost,
  recordLateCancel,
  recordAttendance,
  issueVerificationCode,
  MAX_VERIFICATION_ATTEMPTS,
};

export default flowOrchestratorPlugin;
