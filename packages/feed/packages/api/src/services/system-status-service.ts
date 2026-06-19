import { createHash } from "node:crypto";
import { checkDatabaseHealth, db, queryMonitor } from "@feed/db";
import { logger } from "@feed/shared";
import type { CronJobStats } from "../monitoring/cron-metrics";
import { cronMetrics } from "../monitoring/cron-metrics";
import { getRedisClient, isRedisAvailable } from "../redis/client";
import { getDeploymentEnvironment } from "../utils/environment";

const GAME_TICK_WARNING_MS = 5 * 60 * 1000;
const GAME_TICK_CRITICAL_MS = 10 * 60 * 1000;
const QUERY_SLOW_RATE_WARNING_PERCENT = 5;
const QUERY_SLOW_RATE_CRITICAL_PERCENT = 15;
const MEMORY_WARNING_PERCENT = 85;
const MEMORY_CRITICAL_PERCENT = 95;
const CONTENT_LOOKAHEAD_WARNING_MINUTES = 5;
const REALTIME_LAG_WARNING_SECONDS = 60;
const ALERT_THROTTLE_SECONDS = 30 * 60;
const REDIS_ALERT_PREFIX = "observability:discord-alert:";

type SystemStatusLevel = "healthy" | "warning" | "critical";

interface SystemActivityWindow {
  newUsers: number;
  newPosts: number;
}

interface SystemActivityMetrics {
  lastHour: SystemActivityWindow;
  last24Hours: SystemActivityWindow;
}

interface SystemGameSource {
  id: string;
  isRunning: boolean;
  pausedAt: Date | null;
  currentTick: number;
  lastTickAt: Date | null;
  tickIntervalMs: number;
  startedAt: Date | null;
}

interface SystemLlmMetrics {
  callsLast24h: number;
  inputTokensLast24h: number;
  outputTokensLast24h: number;
  errorsLastHour: number;
}

interface SystemContentMetrics {
  lookaheadMinutes: number;
  activeQuestions: number;
  isHealthy: boolean;
}

interface SystemRealtimeMetrics {
  outboxPending: number;
  outboxLagSeconds: number;
  isHealthy: boolean;
}

interface SystemModerationMetrics {
  pendingReports: number;
}

interface SystemLockInfo {
  id: string;
  lockType: string;
  acquiredAt: string;
  ageSeconds: number;
}

interface SystemTableInfo {
  name: string;
  rowCount: number;
  sizeBytes: number;
  sizeMB: number;
}

interface SystemEnvironmentInfo {
  nodeEnv: string | null;
  vercelEnv: string | null;
  region: string | null;
}

interface SystemPerformanceMetrics {
  query: {
    totalQueries: number;
    slowQueries: number;
    slowRate: number;
    avgDurationMs: number;
    p95DurationMs: number;
    p99DurationMs: number;
    status: SystemStatusLevel;
  };
  memory: {
    heapUsedMB: number;
    heapTotalMB: number;
    externalMB: number;
    rssMB: number;
    usagePercent: number;
    status: SystemStatusLevel;
  };
  server: {
    uptimeSeconds: number;
    uptimeFormatted: string;
    env: string | null;
    pid: number;
  };
}

interface SerializedCronJobStats {
  jobName: string;
  totalExecutions: number;
  successfulExecutions: number;
  skippedExecutions: number;
  failedExecutions: number;
  avgDurationMs: number;
  minDurationMs: number;
  maxDurationMs: number;
  lastExecution: string | null;
  lastSuccess: string | null;
  lastFailure: string | null;
  consecutiveFailures: number;
}

interface CronDashboardSnapshot {
  summary: {
    totalJobs: number;
    healthyJobs: number;
    unhealthyJobs: number;
    totalExecutions: number;
    overallSuccessRate: number;
    avgDurationMs: number;
  };
  alerts: Array<{
    jobName: string;
    type: "consecutive_failures" | "high_duration" | "no_recent_execution";
    message: string;
    severity: "warning" | "critical";
  }>;
  jobs: SerializedCronJobStats[];
}

export interface SystemStatusSubsystem {
  key:
    | "database"
    | "redis"
    | "game-engine"
    | "cron"
    | "realtime"
    | "content"
    | "llm"
    | "query-performance"
    | "memory";
  label: string;
  status: SystemStatusLevel;
  summary: string;
  details: string;
  metric?: {
    label: string;
    value: string;
  };
}

export interface SystemStatusSnapshot {
  status: SystemStatusLevel;
  issues: string[];
  criticalIssues: string[];
  timestamp: string;
  summary: {
    total: number;
    healthyCount: number;
    warningCount: number;
    criticalCount: number;
  };
  subsystems: SystemStatusSubsystem[];
  health: {
    database: boolean;
    redis: boolean;
    overall: boolean;
    timestamp: string;
  };
  game: {
    id: string;
    isRunning: boolean;
    pausedAt: string | null;
    currentTick: number;
    lastTickAt: string | null;
  } | null;
  gameEngine: {
    isRunning: boolean;
    currentDay: number;
    lastTickAt: string | null;
    timeSinceLastTickMs: number | null;
    tickIntervalMs: number;
    uptimeMs: number;
  };
  activityMetrics: SystemActivityMetrics;
  recentErrors: Array<{
    id: string;
    error: string;
    promptType: string;
    createdAt: string;
  }>;
  cronJobs: {
    summary: CronDashboardSnapshot["summary"];
    alerts: CronDashboardSnapshot["alerts"];
    allJobs: CronDashboardSnapshot["jobs"];
    gameTick: SerializedCronJobStats | null;
    agentTick: SerializedCronJobStats | null;
    realtimeDrain: SerializedCronJobStats | null;
  };
  llm: SystemLlmMetrics;
  content: SystemContentMetrics;
  realtime: SystemRealtimeMetrics;
  locks: {
    active: SystemLockInfo[];
  };
  moderation: SystemModerationMetrics;
  database: {
    tables: SystemTableInfo[];
  };
  performance: SystemPerformanceMetrics;
  environment: SystemEnvironmentInfo;
}

export interface BuildSystemStatusInput {
  generatedAt?: Date;
  databaseHealthy: boolean;
  redisHealthy: boolean;
  game: SystemGameSource | null;
  activityMetrics: SystemActivityMetrics;
  cron: {
    summary: CronDashboardSnapshot["summary"];
    alerts: CronDashboardSnapshot["alerts"];
    jobs: CronJobStats[];
  };
  llm: SystemLlmMetrics;
  content: SystemContentMetrics;
  realtime: SystemRealtimeMetrics;
  locks: SystemLockInfo[];
  tables: SystemTableInfo[];
  performance: SystemPerformanceMetrics;
  moderation: SystemModerationMetrics;
  environment: SystemEnvironmentInfo;
}

const inMemoryAlertReservations = new Map<string, number>();

function toIsoString(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null;
}

function formatDuration(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);

  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (secs > 0 || parts.length === 0) parts.push(`${secs}s`);

  return parts.join(" ");
}

function formatPercent(value: number): string {
  return `${Math.round(value * 10) / 10}%`;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function formatCount(value: number): string {
  return value.toLocaleString("en-US");
}

function serializeCronJobStats(job: CronJobStats): SerializedCronJobStats {
  return {
    jobName: job.jobName,
    totalExecutions: job.totalExecutions,
    successfulExecutions: job.successfulExecutions,
    skippedExecutions: job.skippedExecutions,
    failedExecutions: job.failedExecutions,
    avgDurationMs: round(job.avgDurationMs),
    minDurationMs: round(job.minDurationMs),
    maxDurationMs: round(job.maxDurationMs),
    lastExecution: toIsoString(job.lastExecution),
    lastSuccess: toIsoString(job.lastSuccess),
    lastFailure: toIsoString(job.lastFailure),
    consecutiveFailures: job.consecutiveFailures,
  };
}

function withPersistedMetricsSnapshotJob(
  dashboard: ReturnType<typeof cronMetrics.getDashboardMetrics>,
  snapshot: {
    timestamp: Date;
    createdAt: Date;
    snapshotDurationMs: number;
  } | null,
): ReturnType<typeof cronMetrics.getDashboardMetrics> {
  if (!snapshot) {
    return dashboard;
  }

  const existingIndex = dashboard.jobs.findIndex(
    (job) => job.jobName === "metrics-snapshot",
  );

  const metricsSnapshotJob: CronJobStats = {
    jobName: "metrics-snapshot",
    totalExecutions: 1,
    successfulExecutions: 1,
    skippedExecutions: 0,
    failedExecutions: 0,
    avgDurationMs: snapshot.snapshotDurationMs,
    minDurationMs: snapshot.snapshotDurationMs,
    maxDurationMs: snapshot.snapshotDurationMs,
    lastExecution: snapshot.createdAt,
    lastSuccess: snapshot.createdAt,
    lastFailure: undefined,
    consecutiveFailures: 0,
  };

  const jobs =
    existingIndex >= 0
      ? dashboard.jobs.map((job, index) =>
          index === existingIndex ? metricsSnapshotJob : job,
        )
      : [...dashboard.jobs, metricsSnapshotJob];

  const alerts = dashboard.alerts.filter(
    (alert) => alert.jobName !== "metrics-snapshot",
  );
  const totalExecutions = jobs.reduce(
    (sum, job) => sum + job.totalExecutions,
    0,
  );
  const totalSuccesses = jobs.reduce(
    (sum, job) => sum + job.successfulExecutions,
    0,
  );
  const totalDuration = jobs.reduce(
    (sum, job) =>
      sum + job.avgDurationMs * (job.totalExecutions - job.skippedExecutions),
    0,
  );
  const durationCount = jobs.reduce(
    (sum, job) => sum + (job.totalExecutions - job.skippedExecutions),
    0,
  );
  const healthyJobs = jobs.filter((job) => job.consecutiveFailures < 3).length;

  return {
    jobs,
    alerts,
    summary: {
      totalJobs: jobs.length,
      healthyJobs,
      unhealthyJobs: jobs.length - healthyJobs,
      totalExecutions,
      overallSuccessRate:
        totalExecutions > 0 ? (totalSuccesses / totalExecutions) * 100 : 100,
      avgDurationMs: durationCount > 0 ? totalDuration / durationCount : 0,
    },
  };
}

function getQueryStatus(slowRate: number): SystemStatusLevel {
  if (slowRate >= QUERY_SLOW_RATE_CRITICAL_PERCENT) {
    return "critical";
  }

  if (slowRate >= QUERY_SLOW_RATE_WARNING_PERCENT) {
    return "warning";
  }

  return "healthy";
}

function getMemoryStatus(usagePercent: number): SystemStatusLevel {
  if (usagePercent >= MEMORY_CRITICAL_PERCENT) {
    return "critical";
  }

  if (usagePercent >= MEMORY_WARNING_PERCENT) {
    return "warning";
  }

  return "healthy";
}

function getGameEngineSubsystem(
  input: BuildSystemStatusInput,
  generatedAt: Date,
): SystemStatusSubsystem {
  if (!input.databaseHealthy && !input.game) {
    return {
      key: "game-engine",
      label: "Game Engine",
      status: "critical",
      summary: "Unavailable",
      details: "Database is unreachable, game state could not be loaded.",
    };
  }

  if (!input.game) {
    return {
      key: "game-engine",
      label: "Game Engine",
      status: "warning",
      summary: "No continuous game found",
      details: "No active game state was returned by the database.",
    };
  }

  if (!input.game.isRunning) {
    return {
      key: "game-engine",
      label: "Game Engine",
      status: "healthy",
      summary: "Paused",
      details: `Day ${input.game.currentTick} is currently paused.`,
      metric: {
        label: "Current day",
        value: `Day ${input.game.currentTick}`,
      },
    };
  }

  if (!input.game.lastTickAt) {
    return {
      key: "game-engine",
      label: "Game Engine",
      status: "critical",
      summary: "Running without a recent tick",
      details:
        "The game reports as running, but no last tick timestamp is available.",
      metric: {
        label: "Current day",
        value: `Day ${input.game.currentTick}`,
      },
    };
  }

  const tickAgeMs = generatedAt.getTime() - input.game.lastTickAt.getTime();
  if (tickAgeMs > GAME_TICK_CRITICAL_MS) {
    return {
      key: "game-engine",
      label: "Game Engine",
      status: "critical",
      summary: "Tick is stale",
      details: `Last tick was ${Math.round(tickAgeMs / 60000)} minutes ago.`,
      metric: {
        label: "Current day",
        value: `Day ${input.game.currentTick}`,
      },
    };
  }

  if (tickAgeMs > GAME_TICK_WARNING_MS) {
    return {
      key: "game-engine",
      label: "Game Engine",
      status: "warning",
      summary: "Tick is delayed",
      details: `Last tick was ${Math.round(tickAgeMs / 60000)} minutes ago.`,
      metric: {
        label: "Current day",
        value: `Day ${input.game.currentTick}`,
      },
    };
  }

  return {
    key: "game-engine",
    label: "Game Engine",
    status: "healthy",
    summary: "Running normally",
    details: `Last tick ${Math.max(0, Math.round(tickAgeMs / 1000))} seconds ago.`,
    metric: {
      label: "Current day",
      value: `Day ${input.game.currentTick}`,
    },
  };
}

function getCronSubsystem(
  input: BuildSystemStatusInput,
): SystemStatusSubsystem {
  const criticalAlerts = input.cron.alerts.filter(
    (alert) => alert.severity === "critical",
  );
  const warningAlerts = input.cron.alerts.filter(
    (alert) => alert.severity === "warning",
  );

  if (criticalAlerts.length > 0) {
    return {
      key: "cron",
      label: "Cron Jobs",
      status: "critical",
      summary: `${criticalAlerts.length} critical cron alert${criticalAlerts.length === 1 ? "" : "s"}`,
      details: criticalAlerts[0]?.message ?? "Critical cron alerts detected.",
      metric: {
        label: "Healthy jobs",
        value: `${input.cron.summary.healthyJobs}/${input.cron.summary.totalJobs}`,
      },
    };
  }

  if (
    warningAlerts.length > 0 ||
    input.cron.summary.unhealthyJobs > 0 ||
    input.cron.summary.totalJobs === 0
  ) {
    return {
      key: "cron",
      label: "Cron Jobs",
      status: "warning",
      summary:
        input.cron.summary.totalJobs === 0
          ? "No recent cron history"
          : `${warningAlerts.length} warning cron alert${warningAlerts.length === 1 ? "" : "s"}`,
      details:
        warningAlerts[0]?.message ??
        "Cron jobs have not yet produced enough history for a health assessment.",
      metric: {
        label: "Healthy jobs",
        value: `${input.cron.summary.healthyJobs}/${input.cron.summary.totalJobs}`,
      },
    };
  }

  return {
    key: "cron",
    label: "Cron Jobs",
    status: "healthy",
    summary: "No active cron alerts",
    details: `${input.cron.summary.healthyJobs}/${input.cron.summary.totalJobs} tracked jobs are healthy.`,
    metric: {
      label: "Success rate",
      value: formatPercent(input.cron.summary.overallSuccessRate),
    },
  };
}

function getQuerySubsystem(
  input: BuildSystemStatusInput,
): SystemStatusSubsystem {
  const query = input.performance.query;
  const summary =
    query.totalQueries === 0
      ? "No recent query sample"
      : `${formatPercent(query.slowRate)} slow queries`;

  const details =
    query.totalQueries === 0
      ? "No database queries were sampled in the last minute."
      : `P95 ${round(query.p95DurationMs)}ms · ${formatCount(query.totalQueries)} queries in the last minute.`;

  return {
    key: "query-performance",
    label: "Query Performance",
    status: query.status,
    summary,
    details,
    metric: {
      label: "P95 latency",
      value: `${round(query.p95DurationMs)}ms`,
    },
  };
}

function getMemorySubsystem(
  input: BuildSystemStatusInput,
): SystemStatusSubsystem {
  const memory = input.performance.memory;

  return {
    key: "memory",
    label: "Server Memory",
    status: memory.status,
    summary: `${formatPercent(memory.usagePercent)} heap used`,
    details: `${round(memory.heapUsedMB)}MB / ${round(memory.heapTotalMB)}MB heap · RSS ${round(memory.rssMB)}MB.`,
    metric: {
      label: "Uptime",
      value: input.performance.server.uptimeFormatted,
    },
  };
}

export function buildSystemStatusSnapshot(
  input: BuildSystemStatusInput,
): SystemStatusSnapshot {
  const generatedAt = input.generatedAt ?? new Date();

  const subsystems: SystemStatusSubsystem[] = [
    {
      key: "database",
      label: "Database",
      status: input.databaseHealthy ? "healthy" : "critical",
      summary: input.databaseHealthy ? "Connected" : "Unavailable",
      details: input.databaseHealthy
        ? "Primary database health check succeeded."
        : "Database health check failed.",
      metric: {
        label: "Tables sampled",
        value: formatCount(input.tables.length),
      },
    },
    {
      key: "redis",
      label: "Redis",
      status: input.redisHealthy ? "healthy" : "warning",
      summary: input.redisHealthy ? "Available" : "Unavailable",
      details: input.redisHealthy
        ? "Redis-backed cache and coordination are available."
        : "Redis is unavailable; fallbacks may reduce observability quality.",
    },
    getGameEngineSubsystem(input, generatedAt),
    getCronSubsystem(input),
    {
      key: "realtime",
      label: "Realtime Outbox",
      status: input.realtime.isHealthy ? "healthy" : "warning",
      summary: input.realtime.isHealthy
        ? "Realtime delivery is healthy"
        : "Realtime delivery is lagging",
      details: `${formatCount(input.realtime.outboxPending)} pending messages · ${formatCount(input.realtime.outboxLagSeconds)}s oldest lag.`,
      metric: {
        label: "Pending events",
        value: formatCount(input.realtime.outboxPending),
      },
    },
    {
      key: "content",
      label: "Content Pipeline",
      status: input.content.isHealthy ? "healthy" : "warning",
      summary: input.content.isHealthy
        ? "Lookahead is healthy"
        : "Lookahead is below target",
      details: `${formatCount(input.content.lookaheadMinutes)} minutes of lookahead · ${formatCount(input.content.activeQuestions)} active questions.`,
      metric: {
        label: "Lookahead",
        value: `${formatCount(input.content.lookaheadMinutes)} min`,
      },
    },
    {
      key: "llm",
      label: "LLM Calls",
      status: input.llm.errorsLastHour > 0 ? "warning" : "healthy",
      summary:
        input.llm.errorsLastHour > 0
          ? `${formatCount(input.llm.errorsLastHour)} recent error${input.llm.errorsLastHour === 1 ? "" : "s"}`
          : "No recent LLM errors",
      details: `${formatCount(input.llm.callsLast24h)} calls in the last 24 hours.`,
      metric: {
        label: "Errors last hour",
        value: formatCount(input.llm.errorsLastHour),
      },
    },
    getQuerySubsystem(input),
    getMemorySubsystem(input),
  ];

  const criticalIssues = subsystems
    .filter((subsystem) => subsystem.status === "critical")
    .map((subsystem) => `${subsystem.label}: ${subsystem.summary}`);
  const issues = subsystems
    .filter((subsystem) => subsystem.status !== "healthy")
    .map((subsystem) => `${subsystem.label}: ${subsystem.summary}`);

  const criticalCount = subsystems.filter(
    (subsystem) => subsystem.status === "critical",
  ).length;
  const warningCount = subsystems.filter(
    (subsystem) => subsystem.status === "warning",
  ).length;
  const healthyCount = subsystems.length - criticalCount - warningCount;
  const status: SystemStatusLevel =
    criticalCount > 0 ? "critical" : warningCount > 0 ? "warning" : "healthy";

  const timeSinceLastTickMs = input.game?.lastTickAt
    ? generatedAt.getTime() - input.game.lastTickAt.getTime()
    : null;
  const gameUptimeMs = input.game?.startedAt
    ? generatedAt.getTime() - input.game.startedAt.getTime()
    : 0;
  const serializedJobs = input.cron.jobs.map(serializeCronJobStats);

  return {
    status,
    issues,
    criticalIssues,
    timestamp: generatedAt.toISOString(),
    summary: {
      total: subsystems.length,
      healthyCount,
      warningCount,
      criticalCount,
    },
    subsystems,
    health: {
      database: input.databaseHealthy,
      redis: input.redisHealthy,
      overall: input.databaseHealthy && input.redisHealthy,
      timestamp: generatedAt.toISOString(),
    },
    game: input.game
      ? {
          id: input.game.id,
          isRunning: input.game.isRunning,
          pausedAt: toIsoString(input.game.pausedAt),
          currentTick: input.game.currentTick,
          lastTickAt: toIsoString(input.game.lastTickAt),
        }
      : null,
    gameEngine: {
      isRunning: input.game?.isRunning ?? false,
      currentDay: input.game?.currentTick ?? 0,
      lastTickAt: toIsoString(input.game?.lastTickAt),
      timeSinceLastTickMs,
      tickIntervalMs: input.game?.tickIntervalMs ?? 60000,
      uptimeMs: gameUptimeMs,
    },
    activityMetrics: input.activityMetrics,
    // Reserved for LlmCallLog error rows once the snapshot includes them.
    recentErrors: [],
    cronJobs: {
      summary: input.cron.summary,
      alerts: input.cron.alerts,
      allJobs: serializedJobs,
      gameTick:
        serializedJobs.find((job) => job.jobName === "game-tick") ?? null,
      agentTick:
        serializedJobs.find((job) => job.jobName === "agent-tick") ?? null,
      realtimeDrain:
        serializedJobs.find((job) => job.jobName === "realtime-drain") ?? null,
    },
    llm: input.llm,
    content: input.content,
    realtime: input.realtime,
    locks: {
      active: input.locks,
    },
    moderation: input.moderation,
    database: {
      tables: input.tables,
    },
    performance: input.performance,
    environment: input.environment,
  };
}

export async function getSystemStatusSnapshot(): Promise<SystemStatusSnapshot> {
  const generatedAt = new Date();
  const databaseHealthResult = await Promise.allSettled([
    checkDatabaseHealth(),
  ]);
  const databaseHealthy =
    databaseHealthResult[0]?.status === "fulfilled" &&
    Boolean(databaseHealthResult[0].value);

  const redisHealthy = isRedisAvailable();

  const inMemoryCronDashboard = cronMetrics.getDashboardMetrics();

  const queryStats = queryMonitor.getQueryStats(60000);
  const slowRate =
    queryStats.totalQueries > 0
      ? (queryStats.slowQueries / queryStats.totalQueries) * 100
      : 0;
  const memUsage = process.memoryUsage();
  const memoryUsagePercent =
    memUsage.heapTotal > 0 ? (memUsage.heapUsed / memUsage.heapTotal) * 100 : 0;

  const performance: SystemPerformanceMetrics = {
    query: {
      totalQueries: queryStats.totalQueries,
      slowQueries: queryStats.slowQueries,
      slowRate: round(slowRate),
      avgDurationMs: round(queryStats.avgDuration),
      p95DurationMs: round(queryStats.p95Duration),
      p99DurationMs: round(queryStats.p99Duration),
      status: getQueryStatus(slowRate),
    },
    memory: {
      heapUsedMB: round(memUsage.heapUsed / 1024 / 1024),
      heapTotalMB: round(memUsage.heapTotal / 1024 / 1024),
      externalMB: round(memUsage.external / 1024 / 1024),
      rssMB: round(memUsage.rss / 1024 / 1024),
      usagePercent: round(memoryUsagePercent),
      status: getMemoryStatus(memoryUsagePercent),
    },
    server: {
      uptimeSeconds: Math.floor(process.uptime()),
      uptimeFormatted: formatDuration(process.uptime()),
      env: process.env.NODE_ENV ?? null,
      pid: process.pid,
    },
  };

  if (!databaseHealthy) {
    return buildSystemStatusSnapshot({
      generatedAt,
      databaseHealthy,
      redisHealthy,
      game: null,
      activityMetrics: {
        lastHour: { newUsers: 0, newPosts: 0 },
        last24Hours: { newUsers: 0, newPosts: 0 },
      },
      cron: {
        summary: inMemoryCronDashboard.summary,
        alerts: inMemoryCronDashboard.alerts,
        jobs: inMemoryCronDashboard.jobs,
      },
      llm: {
        callsLast24h: 0,
        inputTokensLast24h: 0,
        outputTokensLast24h: 0,
        errorsLastHour: 0,
      },
      content: {
        lookaheadMinutes: 0,
        activeQuestions: 0,
        isHealthy: false,
      },
      realtime: {
        outboxPending: 0,
        outboxLagSeconds: REALTIME_LAG_WARNING_SECONDS,
        isHealthy: false,
      },
      locks: [],
      tables: [],
      performance,
      moderation: {
        pendingReports: 0,
      },
      environment: {
        nodeEnv: process.env.NODE_ENV ?? null,
        vercelEnv: process.env.VERCEL_ENV ?? null,
        region: process.env.VERCEL_REGION ?? null,
      },
    });
  }

  const oneHourAgo = new Date(generatedAt.getTime() - 60 * 60 * 1000);
  const oneDayAgo = new Date(generatedAt.getTime() - 24 * 60 * 60 * 1000);
  const deploymentEnvironment = getDeploymentEnvironment();

  const [
    currentGame,
    newUsersLastHour,
    newUsersLastDay,
    newPostsLastHour,
    newPostsLastDay,
    llmErrorCountResult,
    llmStats,
    tableSizes,
    outboxStats,
    activeLocks,
    latestPost,
    pendingReports,
    activeQuestions,
    latestMetricsSnapshot,
  ] = await Promise.all([
    db.game.findFirst({
      where: { isContinuous: true },
    }),
    db.user.count({ where: { createdAt: { gte: oneHourAgo } } }),
    db.user.count({ where: { createdAt: { gte: oneDayAgo } } }),
    db.post.count({ where: { createdAt: { gte: oneHourAgo } } }),
    db.post.count({ where: { createdAt: { gte: oneDayAgo } } }),
    db.$queryRaw<{ count: string }>`
      SELECT 0::text as count
    `,
    db.$queryRaw<{
      totalCalls: string;
      totalInputTokens: string;
      totalOutputTokens: string;
    }>`
      SELECT
        COUNT(*) as "totalCalls",
        COALESCE(SUM("promptTokens"), 0) as "totalInputTokens",
        COALESCE(SUM("completionTokens"), 0) as "totalOutputTokens"
      FROM "llm_call_logs"
      WHERE "createdAt" >= NOW() - INTERVAL '24 hours'
    `,
    db.$queryRaw<{
      tableName: string;
      rowCount: string;
      sizeBytes: string;
    }>`
      SELECT 
        s.relname as "tableName",
        s.n_live_tup as "rowCount",
        pg_total_relation_size(s.relid) as "sizeBytes"
      FROM pg_stat_user_tables s
      ORDER BY pg_total_relation_size(s.relid) DESC
      LIMIT 20
    `,
    db.$queryRaw<{
      pending: string;
      oldest: Date | null;
    }>`
      SELECT 
        COUNT(*) as pending,
        MIN("createdAt") as oldest
      FROM "RealtimeOutbox"
      WHERE "status" = 'pending'
    `,
    db.generationLock.findMany({
      where: { expiresAt: { gt: generatedAt } },
      orderBy: { lockedAt: "desc" },
      take: 5,
    }),
    db.post.findFirst({
      orderBy: { timestamp: "desc" },
      select: { timestamp: true },
    }),
    db.report.count({
      where: { status: "pending" },
    }),
    db.question.count({
      where: { status: "active" },
    }),
    db.$queryRaw<{
      timestamp: Date;
      createdAt: Date;
      snapshotDurationMs: number;
    }>`
      SELECT "timestamp", "createdAt", "snapshotDurationMs"
      FROM "SystemMetricsSnapshot"
      WHERE "environment" = ${deploymentEnvironment}
      ORDER BY "timestamp" DESC
      LIMIT 1
    `,
  ]);

  const cronDashboard = withPersistedMetricsSnapshotJob(
    inMemoryCronDashboard,
    latestMetricsSnapshot[0] ?? null,
  );

  const recentLlmErrorsCount = llmErrorCountResult[0]
    ? Number(llmErrorCountResult[0].count)
    : 0;
  const llmUsageRow = llmStats[0];
  const outboxPending = outboxStats[0] ? Number(outboxStats[0].pending) : 0;
  const outboxOldest = outboxStats[0]?.oldest ?? null;
  const outboxLagSeconds = outboxOldest
    ? Math.floor(
        (generatedAt.getTime() - new Date(outboxOldest).getTime()) / 1000,
      )
    : 0;
  const lookaheadMinutes = latestPost
    ? Math.floor(
        (new Date(latestPost.timestamp).getTime() - generatedAt.getTime()) /
          60000,
      )
    : 0;

  return buildSystemStatusSnapshot({
    generatedAt,
    databaseHealthy,
    redisHealthy,
    game: currentGame
      ? {
          id: currentGame.id,
          isRunning: currentGame.isRunning,
          pausedAt: currentGame.pausedAt,
          currentTick: currentGame.currentDay,
          lastTickAt: currentGame.lastTickAt,
          tickIntervalMs: currentGame.speed ?? 60000,
          startedAt: currentGame.startedAt,
        }
      : null,
    activityMetrics: {
      lastHour: {
        newUsers: newUsersLastHour,
        newPosts: newPostsLastHour,
      },
      last24Hours: {
        newUsers: newUsersLastDay,
        newPosts: newPostsLastDay,
      },
    },
    cron: {
      summary: cronDashboard.summary,
      alerts: cronDashboard.alerts,
      jobs: cronDashboard.jobs,
    },
    llm: {
      callsLast24h: llmUsageRow ? Number(llmUsageRow.totalCalls) : 0,
      inputTokensLast24h: llmUsageRow
        ? Number(llmUsageRow.totalInputTokens)
        : 0,
      outputTokensLast24h: llmUsageRow
        ? Number(llmUsageRow.totalOutputTokens)
        : 0,
      errorsLastHour: recentLlmErrorsCount,
    },
    content: {
      lookaheadMinutes,
      activeQuestions,
      isHealthy: lookaheadMinutes >= CONTENT_LOOKAHEAD_WARNING_MINUTES,
    },
    realtime: {
      outboxPending,
      outboxLagSeconds,
      isHealthy: outboxLagSeconds < REALTIME_LAG_WARNING_SECONDS,
    },
    locks: activeLocks.map((lock) => ({
      id: lock.id,
      lockType: lock.operation,
      acquiredAt: lock.lockedAt.toISOString(),
      ageSeconds: Math.floor(
        (generatedAt.getTime() - lock.lockedAt.getTime()) / 1000,
      ),
    })),
    tables: tableSizes.map((table) => ({
      name: table.tableName,
      rowCount: Number(table.rowCount),
      sizeBytes: Number(table.sizeBytes),
      sizeMB: round(Number(table.sizeBytes) / 1024 / 1024),
    })),
    performance,
    moderation: {
      pendingReports,
    },
    environment: {
      nodeEnv: process.env.NODE_ENV ?? null,
      vercelEnv: process.env.VERCEL_ENV ?? null,
      region: process.env.VERCEL_REGION ?? null,
    },
  });
}

function cleanupExpiredAlertReservations(nowMs: number) {
  for (const [key, expiresAt] of inMemoryAlertReservations.entries()) {
    if (expiresAt <= nowMs) {
      inMemoryAlertReservations.delete(key);
    }
  }
}

function getAlertFingerprint(snapshot: SystemStatusSnapshot): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        environment:
          snapshot.environment.vercelEnv ?? snapshot.environment.nodeEnv,
        status: snapshot.status,
        criticalIssues: snapshot.criticalIssues,
      }),
    )
    .digest("hex");
}

function getDiscordWebhookUrl(): string | null {
  const value = process.env.DISCORD_SYSTEM_ALERT_WEBHOOK_URL?.trim();
  return value && value.length > 0 ? value : null;
}

async function reserveAlertWindow(fingerprint: string): Promise<boolean> {
  const nowMs = Date.now();
  const expiresAt = nowMs + ALERT_THROTTLE_SECONDS * 1000;
  cleanupExpiredAlertReservations(nowMs);

  if ((inMemoryAlertReservations.get(fingerprint) ?? 0) > nowMs) {
    return false;
  }

  const redis = getRedisClient();
  if (redis) {
    try {
      const redisKey = `${REDIS_ALERT_PREFIX}${fingerprint}`;
      const wasSet = await redis.set(
        redisKey,
        "1",
        "EX",
        ALERT_THROTTLE_SECONDS,
        "NX",
      );
      if (!wasSet) {
        inMemoryAlertReservations.set(fingerprint, expiresAt);
        return false;
      }
    } catch (error) {
      logger.warn(
        "Failed to reserve Redis alert window",
        { error: error instanceof Error ? error.message : String(error) },
        "SystemStatusService",
      );
    }
  }

  inMemoryAlertReservations.set(fingerprint, expiresAt);
  return true;
}

async function releaseAlertWindow(fingerprint: string): Promise<void> {
  inMemoryAlertReservations.delete(fingerprint);
  const redis = getRedisClient();
  if (!redis) {
    return;
  }

  try {
    await redis.del(`${REDIS_ALERT_PREFIX}${fingerprint}`);
  } catch (error) {
    logger.warn(
      "Failed to release Redis alert window",
      { error: error instanceof Error ? error.message : String(error) },
      "SystemStatusService",
    );
  }
}

export function formatSystemStatusDiscordMessage(
  snapshot: SystemStatusSnapshot,
): string {
  const environment =
    snapshot.environment.vercelEnv ?? snapshot.environment.nodeEnv ?? "unknown";
  const region = snapshot.environment.region
    ? `\nRegion: ${snapshot.environment.region}`
    : "";
  const issueLines =
    snapshot.criticalIssues.length > 0
      ? snapshot.criticalIssues
          .slice(0, 5)
          .map((issue) => `- ${issue}`)
          .join("\n")
      : snapshot.issues
          .slice(0, 5)
          .map((issue) => `- ${issue}`)
          .join("\n");

  return [
    `Feed ${snapshot.status.toUpperCase()} system alert`,
    `Environment: ${environment}${region}`,
    `Critical subsystems: ${snapshot.summary.criticalCount}/${snapshot.summary.total}`,
    issueLines.length > 0 ? issueLines : "- No issue details available",
  ].join("\n");
}

export async function sendDiscordSystemAlertIfNeeded(
  snapshot: SystemStatusSnapshot,
): Promise<{ sent: boolean; reason: string }> {
  const webhookUrl = getDiscordWebhookUrl();
  if (!webhookUrl) {
    return { sent: false, reason: "webhook_not_configured" };
  }

  if (snapshot.status !== "critical") {
    return { sent: false, reason: "status_not_critical" };
  }

  const fingerprint = getAlertFingerprint(snapshot);
  const reserved = await reserveAlertWindow(fingerprint);
  if (!reserved) {
    return { sent: false, reason: "throttled" };
  }

  const payload = {
    content: formatSystemStatusDiscordMessage(snapshot),
  };

  try {
    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      await releaseAlertWindow(fingerprint);
      logger.error(
        "Discord system alert failed",
        {
          status: response.status,
          statusText: response.statusText,
        },
        "SystemStatusService",
      );
      return { sent: false, reason: "discord_request_failed" };
    }

    return { sent: true, reason: "sent" };
  } catch (error) {
    await releaseAlertWindow(fingerprint);
    logger.error(
      "Discord system alert threw",
      { error: error instanceof Error ? error.message : String(error) },
      "SystemStatusService",
    );
    return { sent: false, reason: "discord_request_error" };
  }
}
