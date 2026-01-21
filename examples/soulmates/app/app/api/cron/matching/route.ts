import { ok, serverError, unauthorized } from "@/lib/api-utils";
import { sendMatchNotifications } from "@/lib/engine-notify";
import {
  acquireEngineLock,
  listFilterPersonaIds,
  listPriorityPersonaIds,
  listPrioritySchedulePersonaIds,
  loadEngineState,
  releaseEngineLock,
  saveEngineState,
  syncPersonasFromUsers,
} from "@/lib/engine-store";
import { readBooleanEnv, readEnv, readNumberEnv } from "@/lib/env";
import { createOpenAiLlmProvider } from "@/lib/openai-llm";
import type { OutboundChannel } from "@/lib/twilio-messaging";
import { runEngineTick } from "../../../../../engine/engine";
import { createDefaultLlmProvider } from "../../../../../engine/llm";
import type {
  DomainMode,
  EngineOptions,
  EngineState,
  MatchRecord,
  PersonaId,
} from "../../../../../engine/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type CronStatus = "ok" | "skipped";

type CronResponse = {
  status: CronStatus;
  ticks: number;
  durationMs: number;
  matchesCreated: number;
  personasUpdated: number;
  feedbackProcessed: number;
  cursor: number;
  personaCount: number;
  createdPersonaIds: number;
  notificationsSent?: number;
  notificationsFailed?: number;
  notificationsSkipped?: number;
  reason?: string;
};

type MatchingCronConfig = {
  batchSize: number;
  maxCandidates: number;
  smallPassTopK: number;
  largePassTopK: number;
  graphHops: number;
  matchCooldownDays: number;
  reliabilityWeight: number;
  minAvailabilityMinutes: number;
  matchDomains: DomainMode[];
  autoScheduleMatches: boolean;
  requireSameCity: boolean;
  requireSharedInterests: boolean;
  maxTicks: number;
  maxRunMs: number;
  lockMs: number;
  llmMode: "none" | "heuristic" | "openai";
  notifyMatches: boolean;
  notificationChannel: OutboundChannel;
  priorityWindowHours: number;
};

const DOMAIN_LOOKUP: Record<DomainMode, true> = {
  general: true,
  business: true,
  dating: true,
  friendship: true,
};

const clampInt = (value: number, min: number): number =>
  Math.max(min, Math.floor(value));

const readPositiveInt = (key: string, fallback: number, min = 1): number => {
  const value = readNumberEnv(key, fallback);
  return clampInt(Number.isFinite(value) ? value : fallback, min);
};

const readPositiveFloat = (key: string, fallback: number, min = 0): number => {
  const value = readNumberEnv(key, fallback);
  return Math.max(min, Number.isFinite(value) ? value : fallback);
};

const parseDomainList = (value: string | null): DomainMode[] => {
  if (!value) return [];
  const tokens = value
    .split(",")
    .map((token) => token.trim())
    .filter(Boolean);
  return tokens.filter((token): token is DomainMode =>
    Object.hasOwn(DOMAIN_LOOKUP, token),
  );
};

const resolveChannel = (value: string | null): OutboundChannel =>
  value === "whatsapp" ? "whatsapp" : "sms";

const buildConfig = (): MatchingCronConfig => {
  const maxRunMs = readPositiveInt(
    "SOULMATES_MATCHING_CRON_MAX_MS",
    4 * 60 * 1000,
    1000,
  );
  const matchDomains = parseDomainList(readEnv("SOULMATES_MATCH_DOMAINS"));
  const fallbackDomains = parseDomainList(readEnv("SOULMATES_DEFAULT_DOMAINS"));
  const resolvedDomains: DomainMode[] =
    matchDomains.length > 0
      ? matchDomains
      : fallbackDomains.length > 0
        ? fallbackDomains
        : (["general"] as DomainMode[]);
  const llmMode = readEnv("SOULMATES_MATCHING_LLM_MODE");
  const channel = resolveChannel(readEnv("SOULMATES_MATCHING_CHANNEL"));

  return {
    batchSize: readPositiveInt("SOULMATES_MATCHING_BATCH_SIZE", 25, 1),
    maxCandidates: readPositiveInt("SOULMATES_MATCHING_MAX_CANDIDATES", 60, 1),
    smallPassTopK: readPositiveInt("SOULMATES_MATCHING_SMALL_TOPK", 12, 1),
    largePassTopK: readPositiveInt("SOULMATES_MATCHING_LARGE_TOPK", 6, 1),
    graphHops: readPositiveInt("SOULMATES_MATCHING_GRAPH_HOPS", 2, 1),
    matchCooldownDays: readPositiveInt(
      "SOULMATES_MATCHING_COOLDOWN_DAYS",
      30,
      1,
    ),
    reliabilityWeight: readPositiveFloat(
      "SOULMATES_MATCHING_RELIABILITY_WEIGHT",
      1,
      0,
    ),
    minAvailabilityMinutes: readPositiveInt(
      "SOULMATES_MATCHING_MIN_AVAIL_MIN",
      120,
      30,
    ),
    matchDomains: resolvedDomains,
    autoScheduleMatches: readBooleanEnv(
      "SOULMATES_MATCHING_AUTO_SCHEDULE",
      false,
    ),
    requireSameCity: readBooleanEnv("SOULMATES_MATCH_REQUIRE_SAME_CITY", true),
    requireSharedInterests: readBooleanEnv(
      "SOULMATES_MATCH_REQUIRE_SHARED_INTERESTS",
      true,
    ),
    maxTicks: readPositiveInt("SOULMATES_MATCHING_MAX_TICKS", 6, 1),
    maxRunMs,
    lockMs: readPositiveInt(
      "SOULMATES_MATCHING_LOCK_MS",
      maxRunMs + 60_000,
      10_000,
    ),
    llmMode:
      llmMode === "openai"
        ? "openai"
        : llmMode === "heuristic"
          ? "heuristic"
          : "none",
    notifyMatches: readBooleanEnv("SOULMATES_MATCHING_NOTIFY", false),
    notificationChannel: channel,
    priorityWindowHours: readPositiveInt(
      "SOULMATES_PRIORITY_MATCH_WINDOW_HOURS",
      24,
      1,
    ),
  };
};

const isAuthorized = (request: Request): boolean => {
  const secret = readEnv("SOULMATES_CRON_SECRET");
  if (!secret) return true;
  const authHeader = request.headers.get("authorization");
  const bearer = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
  const cronHeader = request.headers.get("x-cron-secret");
  return bearer === secret || cronHeader === secret;
};

const getActivePersonaIds = (state: EngineState): PersonaId[] =>
  state.personas
    .filter((persona) => persona.status === "active")
    .map((persona) => persona.id)
    .sort((a, b) => a - b);

const selectPersonaBatch = (
  ids: PersonaId[],
  cursor: number,
  batchSize: number,
): { batch: PersonaId[]; nextCursor: number } => {
  if (ids.length === 0) {
    return { batch: [], nextCursor: 0 };
  }
  const safeCursor = cursor >= ids.length ? 0 : Math.max(0, cursor);
  const end = Math.min(safeCursor + batchSize, ids.length);
  const batch = ids.slice(safeCursor, end);
  const nextCursor = end >= ids.length ? 0 : end;
  return { batch, nextCursor };
};

async function handleCron(request: Request) {
  if (!isAuthorized(request)) {
    return unauthorized();
  }

  const config = buildConfig();
  const locked = await acquireEngineLock(config.lockMs);
  if (!locked) {
    const response: CronResponse = {
      status: "skipped",
      reason: "locked",
      ticks: 0,
      durationMs: 0,
      matchesCreated: 0,
      personasUpdated: 0,
      feedbackProcessed: 0,
      cursor: 0,
      personaCount: 0,
      createdPersonaIds: 0,
    };
    return ok(response);
  }

  const start = Date.now();
  let state: EngineState | null = null;
  let cursor = 0;
  const priorityScheduleIds = await listPrioritySchedulePersonaIds(
    config.priorityWindowHours,
  );
  const filterIds = await listFilterPersonaIds(config.priorityWindowHours);

  try {
    const record = await loadEngineState();
    cursor = record.cursor;
    const syncResult = await syncPersonasFromUsers(record.state);
    state = syncResult.state;

    const llm =
      config.llmMode === "openai"
        ? createOpenAiLlmProvider()
        : config.llmMode === "heuristic"
          ? createDefaultLlmProvider()
          : null;
    const deps = llm ? { llm } : undefined;

    let ticks = 0;
    let matchesCreated = 0;
    let personasUpdated = 0;
    let feedbackProcessed = 0;
    const createdMatches: MatchRecord[] = [];

    while (Date.now() - start < config.maxRunMs && ticks < config.maxTicks) {
      const activeIds = getActivePersonaIds(state);
      const priorityIds = await listPriorityPersonaIds(
        config.priorityWindowHours,
      );
      const prioritySet = new Set(priorityIds);
      const prioritizedIds = [
        ...priorityIds.filter((id) => activeIds.includes(id)),
        ...activeIds.filter((id) => !prioritySet.has(id)),
      ];
      if (activeIds.length === 0) {
        break;
      }

      const selection = selectPersonaBatch(
        prioritizedIds,
        cursor,
        config.batchSize,
      );
      if (selection.batch.length === 0) {
        cursor = 0;
        break;
      }

      const options: EngineOptions = {
        now: new Date().toISOString(),
        batchSize: config.batchSize,
        maxCandidates: config.maxCandidates,
        smallPassTopK: config.smallPassTopK,
        largePassTopK: config.largePassTopK,
        graphHops: config.graphHops,
        matchCooldownDays: config.matchCooldownDays,
        reliabilityWeight: config.reliabilityWeight,
        minAvailabilityMinutes: config.minAvailabilityMinutes,
        matchDomains: config.matchDomains,
        targetPersonaIds: selection.batch,
        autoScheduleMatches: config.autoScheduleMatches,
        requireSameCity: config.requireSameCity,
        requireSharedInterests: config.requireSharedInterests,
      };

      const result = await runEngineTick(state, options, deps);
      state = result.state;
      matchesCreated += result.matchesCreated.length;
      createdMatches.push(...result.matchesCreated);
      personasUpdated += result.personasUpdated.length;
      feedbackProcessed += result.feedbackProcessed.length;
      cursor = selection.nextCursor;
      ticks += 1;
    }

    if (
      state &&
      priorityScheduleIds.length > 0 &&
      Date.now() - start < config.maxRunMs
    ) {
      const options: EngineOptions = {
        now: new Date().toISOString(),
        batchSize: Math.max(1, priorityScheduleIds.length),
        maxCandidates: config.maxCandidates,
        smallPassTopK: config.smallPassTopK,
        largePassTopK: config.largePassTopK,
        graphHops: config.graphHops,
        matchCooldownDays: config.matchCooldownDays,
        reliabilityWeight: config.reliabilityWeight,
        minAvailabilityMinutes: config.minAvailabilityMinutes,
        matchDomains: config.matchDomains,
        targetPersonaIds: priorityScheduleIds,
        autoScheduleMatches: true,
        requireSameCity: config.requireSameCity,
        requireSharedInterests: config.requireSharedInterests,
      };
      const result = await runEngineTick(state, options, deps);
      state = result.state;
      ticks += 1;
      matchesCreated += result.matchesCreated.length;
      feedbackProcessed += result.feedbackProcessed.length;
      personasUpdated += result.personasUpdated.length;
    }

    if (state && filterIds.length > 0 && Date.now() - start < config.maxRunMs) {
      const options: EngineOptions = {
        now: new Date().toISOString(),
        batchSize: Math.max(1, filterIds.length),
        maxCandidates: config.maxCandidates,
        smallPassTopK: config.smallPassTopK,
        largePassTopK: config.largePassTopK,
        graphHops: config.graphHops,
        matchCooldownDays: config.matchCooldownDays,
        reliabilityWeight: config.reliabilityWeight,
        minAvailabilityMinutes: config.minAvailabilityMinutes,
        matchDomains: config.matchDomains,
        targetPersonaIds: filterIds,
        autoScheduleMatches: config.autoScheduleMatches,
        requireSameCity: false,
        requireSharedInterests: false,
      };
      const result = await runEngineTick(state, options, deps);
      state = result.state;
      ticks += 1;
      matchesCreated += result.matchesCreated.length;
      feedbackProcessed += result.feedbackProcessed.length;
      personasUpdated += result.personasUpdated.length;
    }

    let notificationsSent = 0;
    let notificationsFailed = 0;
    let notificationsSkipped = 0;
    if (config.notifyMatches && createdMatches.length > 0) {
      try {
        const notifyResult = await sendMatchNotifications(
          state,
          createdMatches,
          {
            channel: config.notificationChannel,
          },
        );
        state = notifyResult.state;
        notificationsSent = notifyResult.sent;
        notificationsFailed = notifyResult.failed;
        notificationsSkipped = notifyResult.skipped;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error("[Cron] Match notifications failed:", message);
      }
    }

    const durationMs = Date.now() - start;
    await saveEngineState({
      state,
      cursor,
      lastRunAt: new Date(),
      lastRunDurationMs: durationMs,
      lockedUntil: null,
    });

    const response: CronResponse = {
      status: "ok",
      ticks,
      durationMs,
      matchesCreated,
      personasUpdated,
      feedbackProcessed,
      cursor,
      personaCount: state.personas.length,
      createdPersonaIds: syncResult.createdPersonaIds.length,
      notificationsSent,
      notificationsFailed,
      notificationsSkipped,
    };
    return ok(response);
  } catch (err) {
    const durationMs = Date.now() - start;
    if (state) {
      await saveEngineState({
        state,
        cursor,
        lastRunAt: new Date(),
        lastRunDurationMs: durationMs,
        lockedUntil: null,
      });
    } else {
      await releaseEngineLock();
    }
    const message = err instanceof Error ? err.message : String(err);
    console.error("[Cron] Matching run failed:", message);
    return serverError("Matching cron failed.");
  }
}

export async function GET(request: Request) {
  return handleCron(request);
}

export async function POST(request: Request) {
  return handleCron(request);
}
