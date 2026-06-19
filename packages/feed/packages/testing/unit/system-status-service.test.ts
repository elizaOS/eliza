import { describe, expect, test } from "bun:test";
import {
  type BuildSystemStatusInput,
  buildSystemStatusSnapshot,
  formatSystemStatusDiscordMessage,
} from "@feed/api";

function createBaseInput(): BuildSystemStatusInput {
  return {
    generatedAt: new Date("2026-03-07T12:00:00.000Z"),
    databaseHealthy: true,
    redisHealthy: true,
    game: {
      id: "game-1",
      isRunning: true,
      pausedAt: null,
      currentTick: 42,
      lastTickAt: new Date("2026-03-07T11:59:00.000Z"),
      tickIntervalMs: 60_000,
      startedAt: new Date("2026-03-07T08:00:00.000Z"),
    },
    activityMetrics: {
      lastHour: { newUsers: 3, newPosts: 9 },
      last24Hours: { newUsers: 20, newPosts: 120 },
    },
    cron: {
      summary: {
        totalJobs: 3,
        healthyJobs: 3,
        unhealthyJobs: 0,
        totalExecutions: 50,
        overallSuccessRate: 100,
        avgDurationMs: 1500,
      },
      alerts: [],
      jobs: [
        {
          jobName: "game-tick",
          totalExecutions: 20,
          successfulExecutions: 20,
          skippedExecutions: 0,
          failedExecutions: 0,
          avgDurationMs: 1100,
          minDurationMs: 800,
          maxDurationMs: 1500,
          lastExecution: new Date("2026-03-07T11:59:00.000Z"),
          lastSuccess: new Date("2026-03-07T11:59:00.000Z"),
          lastFailure: undefined,
          consecutiveFailures: 0,
        },
      ],
    },
    llm: {
      callsLast24h: 1200,
      inputTokensLast24h: 50_000,
      outputTokensLast24h: 25_000,
      errorsLastHour: 0,
    },
    content: {
      lookaheadMinutes: 18,
      activeQuestions: 4,
      isHealthy: true,
    },
    realtime: {
      outboxPending: 0,
      outboxLagSeconds: 0,
      isHealthy: true,
    },
    locks: [],
    tables: [
      {
        name: "Post",
        rowCount: 100,
        sizeBytes: 1024,
        sizeMB: 0,
      },
    ],
    performance: {
      query: {
        totalQueries: 100,
        slowQueries: 1,
        slowRate: 1,
        avgDurationMs: 12,
        p95DurationMs: 30,
        p99DurationMs: 60,
        status: "healthy",
      },
      memory: {
        heapUsedMB: 120,
        heapTotalMB: 256,
        externalMB: 10,
        rssMB: 220,
        usagePercent: 46.9,
        status: "healthy",
      },
      server: {
        uptimeSeconds: 14_400,
        uptimeFormatted: "4h 0m",
        env: "test",
        pid: 1234,
      },
    },
    moderation: {
      pendingReports: 2,
    },
    environment: {
      nodeEnv: "test",
      vercelEnv: "preview",
      region: "cdg1",
    },
  };
}

describe("system-status-service", () => {
  test("marks database outages as critical", () => {
    const snapshot = buildSystemStatusSnapshot({
      ...createBaseInput(),
      databaseHealthy: false,
      game: null,
      tables: [],
      content: {
        lookaheadMinutes: 0,
        activeQuestions: 0,
        isHealthy: false,
      },
      realtime: {
        outboxPending: 0,
        outboxLagSeconds: 60,
        isHealthy: false,
      },
    });

    expect(snapshot.status).toBe("critical");
    expect(snapshot.criticalIssues).toContain("Database: Unavailable");
    expect(
      snapshot.subsystems.find((item) => item.key === "database")?.status,
    ).toBe("critical");
  });

  test("promotes stale game ticks and cron failures into critical issues", () => {
    const snapshot = buildSystemStatusSnapshot({
      ...createBaseInput(),
      game: {
        ...createBaseInput().game!,
        lastTickAt: new Date("2026-03-07T11:47:00.000Z"),
      },
      cron: {
        ...createBaseInput().cron,
        summary: {
          ...createBaseInput().cron.summary,
          healthyJobs: 2,
          unhealthyJobs: 1,
        },
        alerts: [
          {
            jobName: "realtime-drain",
            type: "consecutive_failures",
            message: "5 consecutive failures",
            severity: "critical",
          },
        ],
      },
    });

    expect(snapshot.status).toBe("critical");
    expect(snapshot.criticalIssues).toContain("Game Engine: Tick is stale");
    expect(snapshot.criticalIssues).toContain(
      "Cron Jobs: 1 critical cron alert",
    );
  });

  test("formats discord alerts with environment and issue context", () => {
    const snapshot = buildSystemStatusSnapshot({
      ...createBaseInput(),
      performance: {
        ...createBaseInput().performance,
        memory: {
          ...createBaseInput().performance.memory,
          usagePercent: 96,
          status: "critical",
        },
      },
    });

    const message = formatSystemStatusDiscordMessage(snapshot);

    expect(message).toContain("Feed CRITICAL system alert");
    expect(message).toContain("Environment: preview");
    expect(message).toContain("Server Memory: 96% heap used");
  });
});
