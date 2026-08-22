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

import {
  ElizaError,
  logger as elizaLogger,
  type IAgentRuntime,
} from "@elizaos/core";

/** Timeout for trajectory DB calls to prevent blocking agent spawn. */
const QUERY_TIMEOUT_MS = 5000;

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
  /** @deprecated Retained for source compatibility; traversal is exhaustive. */
  maxTrajectories?: number;
  /** @deprecated Retained for source compatibility; results are complete. */
  maxEntries?: number;
  /** @deprecated Retained for source compatibility; no recency window is applied. */
  lookbackHours?: number;
  /** @deprecated Retained for source compatibility; no relevance filter is applied. */
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
  const runtimeAny = runtime as {
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
    offset?: number;
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
    offset?: number;
    limit?: number;
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

function assertWellFormedExperienceText(value: string, field: string): string {
  if (value.toWellFormed() !== value) {
    throw new ElizaError("Trajectory experience contains malformed Unicode", {
      code: "TRAJECTORY_EXPERIENCE_MALFORMED_UNICODE",
      context: { field },
    });
  }
  return value;
}

function readMetadataInsights(value: unknown, trajectoryId: string): string[] {
  if (value === undefined) return [];
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== "string")
  ) {
    throw new ElizaError("Stored trajectory insights are malformed", {
      code: "TRAJECTORY_EXPERIENCE_METADATA_INVALID",
      context: { trajectoryId },
    });
  }
  return value.map((entry, index) =>
    assertWellFormedExperienceText(entry, `${trajectoryId}.insights[${index}]`),
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
    insights.push(match[1]);
    match = decisionPattern.exec(response);
  }

  // Extract keyDecision from coordination responses
  const keyDecisionPattern = /"keyDecision"\s*:\s*"([^"]+)"/g;
  match = keyDecisionPattern.exec(response);
  while (match !== null) {
    insights.push(match[1]);
    match = keyDecisionPattern.exec(response);
  }

  // For turn-complete and coordination decisions, extract the reasoning
  if (
    (purpose === "turn-complete" || purpose === "coordination") &&
    insights.length === 0
  ) {
    const reasoningPattern = /"reasoning"\s*:\s*"([^"]+)"/;
    const reasoningMatch = response.match(reasoningPattern);
    if (reasoningMatch && reasoningMatch[1].length >= 20) {
      insights.push(reasoningMatch[1]);
    }
  }

  return insights;
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
  const { repo } = options;

  const logger = getTrajectoryLogger(runtime);
  if (!logger) return [];

  try {
    const summaries: Awaited<
      ReturnType<TrajectoryLoggerRef["listTrajectories"]>
    >["trajectories"] = [];
    const seenTrajectoryIds = new Set<string>();
    const pageSize = 500;
    let offset = 0;
    let expectedTotal: number | undefined;
    while (true) {
      const page = await withTimeout(
        logger.listTrajectories({
          source: "orchestrator",
          limit: pageSize,
          offset,
        }),
        QUERY_TIMEOUT_MS,
      );
      if (page.trajectories.length > pageSize) {
        throw new ElizaError("Trajectory query exceeded its requested page", {
          code: "TRAJECTORY_PAGE_INVALID",
          context: { offset, pageSize, returned: page.trajectories.length },
        });
      }
      if (expectedTotal === undefined) {
        expectedTotal = page.total;
      } else if (page.total !== expectedTotal) {
        throw new ElizaError("Trajectory inventory changed during traversal", {
          code: "TRAJECTORY_PAGINATION_CHANGED",
          context: { offset, expectedTotal, observedTotal: page.total },
        });
      }
      for (const summary of page.trajectories) {
        if (seenTrajectoryIds.has(summary.id)) {
          throw new ElizaError("Trajectory pagination repeated a record", {
            code: "TRAJECTORY_PAGINATION_REPEATED",
            context: { offset, trajectoryId: summary.id },
          });
        }
        seenTrajectoryIds.add(summary.id);
        summaries.push(summary);
      }
      offset += page.trajectories.length;
      if (offset >= page.total) break;
      if (page.trajectories.length === 0) {
        throw new ElizaError("Trajectory pagination did not advance", {
          code: "TRAJECTORY_PAGINATION_STALLED",
          context: { offset, total: page.total },
        });
      }
    }
    if (summaries.length !== expectedTotal) {
      throw new ElizaError(
        "Trajectory traversal returned an incomplete inventory",
        {
          code: "TRAJECTORY_PAGINATION_INCOMPLETE",
          context: { expectedTotal, returned: summaries.length },
        },
      );
    }

    if (summaries.length === 0) return [];

    const experiences: PastExperience[] = [];

    // Scan each trajectory for insights. Prefer pre-extracted insights from
    // metadata (populated at write time by eliza's trajectory-persistence)
    // to avoid loading full trajectory details with their large prompt/response
    // payloads. Fall back to getTrajectoryDetail for older trajectories that
    // predate the metadata insight extraction.
    for (const summary of summaries) {
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
      const metadataInsights = readMetadataInsights(
        metadata?.insights,
        summary.id,
      );
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
      elizaLogger.debug(
        `[trajectory-feedback] Slow path: loading full detail for ${summary.id} (no metadata insights)`,
      );
      const detail = await withTimeout(
        logger.getTrajectoryDetail(summary.id),
        QUERY_TIMEOUT_MS,
      );
      if (!detail || !Array.isArray(detail.steps)) {
        throw new ElizaError(
          "Trajectory detail is unavailable for complete experience loading",
          {
            code: "TRAJECTORY_EXPERIENCE_DETAIL_UNAVAILABLE",
            context: {
              trajectoryId: summary.id,
              reason: detail ? "steps_missing" : "detail_missing",
            },
          },
        );
      }

      for (const step of detail.steps) {
        if (!step.llmCalls) continue;

        for (const call of step.llmCalls) {
          if (!call.response) continue;

          const insights = extractInsights(
            assertWellFormedExperienceText(
              call.response,
              `${summary.id}.llmCall.response`,
            ),
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

    return experiences;
  } catch (err) {
    // error-policy:J2 incomplete experience context must fail explicitly.
    elizaLogger.error(
      `[trajectory-feedback] Failed to query past experience: ${err}`,
    );
    if (err instanceof ElizaError) throw err;
    throw new ElizaError("Failed to load complete trajectory experience", {
      code: "TRAJECTORY_EXPERIENCE_LOAD_FAILED",
      cause: err,
    });
  }
}
