/**
 * Trajectory Feedback — Past Experience Injection
 *
 * Queries the trajectory database for past orchestrator decisions and
 * formats relevant experience as agent memory context. This closes the
 * loop between trajectory *output* (logging decisions) and trajectory
 * *input* (feeding experience back to agents at spawn time).
 *
 * Inspired by "Codified Context" (arXiv:2602.20478) — known failure
 * modes and past decisions are pre-loaded into agent context so they
 * don't repeat mistakes or re-derive solutions.
 *
 * @module services/trajectory-feedback
 */

import { logger as elizaLogger, type IAgentRuntime } from "@elizaos/core";

/** Timeout for trajectory DB calls to prevent blocking agent spawn. */
const QUERY_TIMEOUT_MS = 5000;
const SLOW_PATH_BUDGET_MS = 15_000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(
        () => reject(new Error(`Trajectory query timed out after ${ms}ms`)),
        ms,
      ),
    ),
  ]);
}

// ─── Types ───

/** A distilled experience entry from a past trajectory. */
interface PastExperience {
  /** When this experience was recorded */
  timestamp: number;
  /** The orchestrator decision type (coordination, turn-complete, etc.) */
  decisionType: string;
  /** Agent label that produced this experience */
  taskLabel: string;
  /** The key insight or decision (extracted from LLM response) */
  insight: string;
}

/** Options for querying past experience. */
export interface TrajectoryFeedbackOptions {
  /** Maximum number of recent trajectories to scan (default: 30) */
  maxTrajectories?: number;
  /** Maximum number of experience entries to return (default: 8) */
  maxEntries?: number;
  /** Only include trajectories from the last N hours (default: 48) */
  lookbackHours?: number;
  /** Task description for relevance filtering */
  taskDescription?: string;
  /** Repository URL — only return experience from the same repo */
  repo?: string;
}

// ─── Trajectory Logger Access ───

/**
 * Resolve the trajectory logger from the runtime. Returns null if
 * trajectory logging isn't available (e.g. no database).
 */
function getTrajectoryLogger(
  runtime: IAgentRuntime,
): TrajectoryLoggerRef | null {
  const runtimeAny = runtime as unknown as {
    getService?: (serviceType: string) => unknown;
    getServicesByType?: (serviceType: string) => unknown[];
  };

  // Try getService first (direct lookup)
  if (typeof runtimeAny.getService === "function") {
    const svc = runtimeAny.getService("trajectories");
    if (svc && typeof svc === "object" && hasListMethod(svc)) {
      return svc as TrajectoryLoggerRef;
    }
  }

  // Fallback: getServicesByType
  if (typeof runtimeAny.getServicesByType === "function") {
    const services = runtimeAny.getServicesByType("trajectories");
    if (Array.isArray(services)) {
      for (const svc of services) {
        if (svc && typeof svc === "object" && hasListMethod(svc)) {
          return svc as TrajectoryLoggerRef;
        }
      }
    }
  }

  return null;
}

type TrajectoryLoggerRef = {
  listTrajectories: (options: {
    source?: string;
    limit?: number;
    startDate?: string;
  }) => Promise<{
    trajectories: Array<{
      id: string;
      source: string;
      startTime: number;
      llmCallCount: number;
      createdAt: string;
      metadata?: Record<string, unknown>;
    }>;
    total: number;
  }>;
  getTrajectoryDetail: (id: string) => Promise<{
    trajectoryId: string;
    metadata?: Record<string, unknown>;
    steps?: Array<{
      llmCalls?: Array<{
        purpose?: string;
        userPrompt?: string;
        response?: string;
        timestamp?: number;
      }>;
    }>;
  } | null>;
};

function hasListMethod(obj: object): boolean {
  const candidate = obj as Record<string, unknown>;
  return (
    typeof candidate.listTrajectories === "function" &&
    typeof candidate.getTrajectoryDetail === "function"
  );
}

// ─── Experience Extraction ───

/**
 * Extract key decisions and insights from an LLM response.
 * Looks for structured decision markers and significant reasoning.
 */
function extractInsights(response: string, purpose: string): string[] {
  const insights: string[] = [];

  // Extract explicit DECISION markers
  const decisionPattern = /DECISION:\s*(.+?)(?:\n|$)/gi;
  let match = decisionPattern.exec(response);
  while (match !== null) {
    insights.push(match[1].trim());
    match = decisionPattern.exec(response);
  }

  // Extract keyDecision from coordination responses
  const keyDecisionPattern = /"keyDecision"\s*:\s*"([^"]+)"/g;
  match = keyDecisionPattern.exec(response);
  while (match !== null) {
    insights.push(match[1].trim());
    match = keyDecisionPattern.exec(response);
  }

  // For turn-complete and coordination decisions, extract the reasoning
  if (
    (purpose === "turn-complete" || purpose === "coordination") &&
    insights.length === 0
  ) {
    const reasoningPattern = /"reasoning"\s*:\s*"([^"]{20,200})"/;
    const reasoningMatch = response.match(reasoningPattern);
    if (reasoningMatch) {
      insights.push(reasoningMatch[1].trim());
    }
  }

  return insights;
}

/**
 * Check if a past experience is potentially relevant to a new task.
 * Uses simple keyword overlap — not semantic search, but fast and
 * good enough for catching repeated patterns.
 */
function isRelevant(
  experience: PastExperience,
  taskDescription: string,
): boolean {
  if (!taskDescription) return true; // No filter = include all

  const taskWords = new Set(
    taskDescription
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 3),
  );

  const insightWords = experience.insight
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 3);

  // At least 2 meaningful word overlaps
  let overlap = 0;
  for (const word of insightWords) {
    if (taskWords.has(word)) overlap++;
    if (overlap >= 2) return true;
  }

  return false;
}

// ─── Main Query ───

/**
 * Query the trajectory database for past orchestrator decisions and
 * return distilled experience entries relevant to the current task.
 */
export async function queryPastExperience(
  runtime: IAgentRuntime,
  options: TrajectoryFeedbackOptions = {},
): Promise<PastExperience[]> {
  const {
    maxTrajectories = 30,
    maxEntries = 8,
    lookbackHours = 48,
    taskDescription,
    repo,
  } = options;

  const logger = getTrajectoryLogger(runtime);
  if (!logger) return [];

  const startDate = new Date(
    Date.now() - lookbackHours * 60 * 60 * 1000,
  ).toISOString();

  try {
    // Fetch recent orchestrator trajectories
    const result = await withTimeout(
      logger.listTrajectories({
        source: "orchestrator",
        limit: maxTrajectories,
        startDate,
      }),
      QUERY_TIMEOUT_MS,
    );

    if (result.trajectories.length === 0) return [];

    const experiences: PastExperience[] = [];
    const slowPathDeadline = Date.now() + SLOW_PATH_BUDGET_MS;

    // Scan each trajectory for insights. Prefer pre-extracted insights from
    // metadata (populated at write time by eliza's trajectory-persistence)
    // to avoid loading full trajectory details with their large prompt/response
    // payloads. Fall back to getTrajectoryDetail for older trajectories that
    // predate the metadata insight extraction.
    const maxScans = Math.min(result.trajectories.length, maxTrajectories);
    for (let scanIdx = 0; scanIdx < maxScans; scanIdx++) {
      const summary = result.trajectories[scanIdx];

      const metadata = summary.metadata as
        | {
            orchestrator?: {
              decisionType?: string;
              taskLabel?: string;
              repo?: string;
            };
            insights?: unknown;
          }
        | undefined;
      const metadataInsights = Array.isArray(metadata?.insights)
        ? metadata.insights
            .filter(
              (value): value is string =>
                typeof value === "string" && value.trim().length > 0,
            )
            .slice(0, 50)
        : [];
      const decisionType = metadata?.orchestrator?.decisionType ?? "unknown";
      const taskLabel = metadata?.orchestrator?.taskLabel ?? "";
      const trajectoryRepo = metadata?.orchestrator?.repo;

      // Filter by repo: if a repo is specified, only include trajectories
      // from the same repo. This ensures agents working on repo A don't get
      // decisions made for repo B.
      if (repo && (!trajectoryRepo || trajectoryRepo !== repo)) continue;

      // Fast path: use pre-extracted insights from metadata (no full detail load)
      if (metadataInsights.length > 0) {
        elizaLogger.debug(
          `[trajectory-feedback] Fast path: ${metadataInsights.length} insight(s) from metadata for ${summary.id}`,
        );
        for (const insight of metadataInsights) {
          experiences.push({
            timestamp: summary.startTime,
            decisionType,
            taskLabel,
            insight,
          });
        }
        continue;
      }

      // Slow path (fallback): load full detail for pre-extraction trajectories
      if (Date.now() > slowPathDeadline) {
        elizaLogger.debug(
          `[trajectory-feedback] Slow path budget exhausted; stopping detail loads`,
        );
        break;
      }
      elizaLogger.debug(
        `[trajectory-feedback] Slow path: loading full detail for ${summary.id} (no metadata insights)`,
      );
      const detail = await withTimeout(
        logger.getTrajectoryDetail(summary.id),
        QUERY_TIMEOUT_MS,
      ).catch(() => null);
      if (!detail?.steps) continue;

      for (const step of detail.steps) {
        if (!step.llmCalls) continue;

        for (const call of step.llmCalls) {
          if (!call.response) continue;

          const insights = extractInsights(
            call.response,
            call.purpose ?? decisionType,
          );

          for (const insight of insights) {
            experiences.push({
              timestamp: call.timestamp ?? summary.startTime,
              decisionType: call.purpose ?? decisionType,
              taskLabel,
              insight,
            });
          }
        }
      }
    }

    // Filter by relevance if task description provided
    let filtered = taskDescription
      ? experiences.filter((e) => isRelevant(e, taskDescription))
      : experiences;

    // If relevance filtering removed everything, fall back to all experiences
    if (filtered.length === 0 && experiences.length > 0) {
      filtered = experiences;
    }

    // Deduplicate by insight text (keep most recent)
    const seen = new Map<string, PastExperience>();
    for (const exp of filtered) {
      const key = exp.insight.toLowerCase();
      const existing = seen.get(key);
      if (!existing || exp.timestamp > existing.timestamp) {
        seen.set(key, exp);
      }
    }

    // Return most recent entries, capped
    return Array.from(seen.values())
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, maxEntries);
  } catch (err) {
    // Non-critical — log and return empty
    elizaLogger.error(
      `[trajectory-feedback] Failed to query past experience: ${err}`,
    );
    return [];
  }
}

// ─── Formatting ───

/**
 * Format past experience entries as a markdown section suitable for
 * injection into agent memory (CLAUDE.md / GEMINI.md).
 *
 * Returns empty string if no relevant experience is found.
 */
export function formatPastExperience(experiences: PastExperience[]): string {
  if (experiences.length === 0) return "";

  const lines = experiences.map((e) => {
    const age = formatAge(e.timestamp);
    const label = e.taskLabel ? ` [${e.taskLabel}]` : "";
    return `- ${e.insight}${label} (${age})`;
  });

  return (
    `# Past Experience\n\n` +
    `The following decisions and insights were captured from recent agent sessions. ` +
    `Use them to avoid repeating mistakes and to stay consistent with established patterns.\n\n` +
    `${lines.join("\n")}\n`
  );
}

/** Format a timestamp as a human-readable relative age (e.g. "2h ago", "1d ago"). */
function formatAge(timestamp: number): string {
  const diffMs = Date.now() - timestamp;
  const hours = Math.floor(diffMs / (1000 * 60 * 60));
  if (hours < 1) return "just now";
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
