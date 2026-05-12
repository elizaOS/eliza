/**
 * `recentTaskStatesProvider` — summarizes recent `ScheduledTask` outcomes so
 * the planner can (a) bring patterns up proactively (the "quiet-user
 * watcher" reads this), and (b) answer "did I check in yesterday?" without
 * scanning rows.
 *
 * Frozen contract (`wave1-interfaces.md` §4.4 + `GAP_ASSESSMENT.md` §3.12):
 *
 *   summarize(opts?): Promise<{ summary, streaks, notable }>
 *
 * **Wave-1 data source.** The W1-A `scheduled_task_log` is the canonical
 * source. Until W1-A's spine is wired in, this provider reads the
 * fallback in-memory ledger (`scheduled_task_log` shim) the W1-C runner
 * stub keeps. Both shapes are read through `readScheduledTaskLog`, so the
 * W1-A swap is a single import line.
 */

import { hasOwnerAccess } from "@elizaos/agent";
import type {
  IAgentRuntime,
  Memory,
  Provider,
  ProviderResult,
  State,
} from "@elizaos/core";
import { logger } from "@elizaos/core";
import { asCacheRuntime } from "../lifeops/runtime-cache.js";
import type {
  ScheduledTaskKind,
  TerminalState,
} from "../lifeops/wave1-types.js";

export interface RecentTaskStateEntry {
  taskId: string;
  kind: ScheduledTaskKind;
  outcome: TerminalState | "fired" | "acknowledged";
  recordedAt: string;
  subjectId?: string;
  notable?: string;
}

export interface RecentTaskStatesSummary {
  summary: string;
  streaks: Array<{
    kind: ScheduledTaskKind;
    outcome: TerminalState;
    consecutive: number;
  }>;
  notable: Array<{ taskId: string; observation: string }>;
}

export interface RecentTaskStatesProvider {
  summarize(opts?: {
    kinds?: ScheduledTaskKind[];
    subjectIds?: string[];
    lookbackDays?: number;
  }): Promise<RecentTaskStatesSummary>;
}

const TASK_LOG_CACHE_KEY = "eliza:lifeops:scheduled-task-log:v1";
const DEFAULT_LOOKBACK_DAYS = 7;

/**
 * Read the scheduled-task log. W1-A will swap the implementation to read
 * from the real `scheduled_task_log` SQL table; the wave-1 fallback is the
 * cache-backed list maintained alongside the in-memory runner. Either way,
 * entries surface in **chronological order (oldest first)**.
 */
export async function readScheduledTaskLog(
  runtime: IAgentRuntime,
): Promise<RecentTaskStateEntry[]> {
  const cache = asCacheRuntime(runtime);
  const stored =
    await cache.getCache<RecentTaskStateEntry[]>(TASK_LOG_CACHE_KEY);
  if (!Array.isArray(stored)) return [];
  return stored
    .filter(
      (entry): entry is RecentTaskStateEntry =>
        Boolean(entry) &&
        typeof entry.taskId === "string" &&
        typeof entry.recordedAt === "string",
    )
    .slice()
    .sort((a, b) => Date.parse(a.recordedAt) - Date.parse(b.recordedAt));
}

/**
 * Test/integration helper — append an entry to the log. The W1-A runner
 * will own the canonical write path.
 */
export async function appendScheduledTaskLogEntry(
  runtime: IAgentRuntime,
  entry: RecentTaskStateEntry,
): Promise<void> {
  const cache = asCacheRuntime(runtime);
  const existing =
    (await cache.getCache<RecentTaskStateEntry[]>(TASK_LOG_CACHE_KEY)) ?? [];
  existing.push(entry);
  await cache.setCache<RecentTaskStateEntry[]>(TASK_LOG_CACHE_KEY, existing);
}

const TERMINAL_OUTCOMES: ReadonlySet<TerminalState> = new Set<TerminalState>([
  "completed",
  "skipped",
  "expired",
  "failed",
  "dismissed",
]);

function isTerminal(outcome: string): outcome is TerminalState {
  return TERMINAL_OUTCOMES.has(outcome as TerminalState);
}

interface SummaryAccumulator {
  byKind: Map<
    ScheduledTaskKind,
    { fires: number; outcomes: Map<string, number> }
  >;
  /** kind → ordered terminal outcomes (chronological) */
  trail: Map<ScheduledTaskKind, TerminalState[]>;
  notable: Array<{ taskId: string; observation: string }>;
}

function summarizeEntries(
  entries: RecentTaskStateEntry[],
): RecentTaskStatesSummary {
  const acc: SummaryAccumulator = {
    byKind: new Map(),
    trail: new Map(),
    notable: [],
  };
  for (const entry of entries) {
    const bucket = acc.byKind.get(entry.kind) ?? {
      fires: 0,
      outcomes: new Map<string, number>(),
    };
    bucket.fires += 1;
    bucket.outcomes.set(
      entry.outcome,
      (bucket.outcomes.get(entry.outcome) ?? 0) + 1,
    );
    acc.byKind.set(entry.kind, bucket);
    if (isTerminal(entry.outcome)) {
      const trail = acc.trail.get(entry.kind) ?? [];
      trail.push(entry.outcome);
      acc.trail.set(entry.kind, trail);
    }
    if (entry.notable) {
      acc.notable.push({ taskId: entry.taskId, observation: entry.notable });
    }
  }

  const streaks: RecentTaskStatesSummary["streaks"] = [];
  for (const [kind, trail] of acc.trail) {
    if (trail.length === 0) continue;
    const tail = trail[trail.length - 1];
    let consecutive = 1;
    for (let i = trail.length - 2; i >= 0; i -= 1) {
      if (trail[i] === tail) consecutive += 1;
      else break;
    }
    if (consecutive >= 2) {
      streaks.push({ kind, outcome: tail, consecutive });
    }
  }

  const summaryLines: string[] = [];
  for (const [kind, bucket] of acc.byKind) {
    const completed = bucket.outcomes.get("completed") ?? 0;
    const skipped = bucket.outcomes.get("skipped") ?? 0;
    const expired = bucket.outcomes.get("expired") ?? 0;
    const dismissed = bucket.outcomes.get("dismissed") ?? 0;
    summaryLines.push(
      `${kind}: ${completed} done / ${skipped} skipped / ${expired} expired / ${dismissed} dismissed (over ${bucket.fires} fires)`,
    );
  }
  for (const streak of streaks) {
    if (streak.consecutive >= 3) {
      summaryLines.push(
        `${streak.kind} ${streak.outcome} streak: ${streak.consecutive} in a row`,
      );
    }
  }
  if (summaryLines.length === 0) {
    summaryLines.push(
      "No recent scheduled-task activity in the lookback window.",
    );
  }
  return {
    summary: summaryLines.join("\n"),
    streaks,
    notable: acc.notable.slice(0, 10),
  };
}

export function createRecentTaskStatesProvider(
  runtime: IAgentRuntime,
): RecentTaskStatesProvider {
  return {
    async summarize(opts = {}) {
      const lookbackDays = opts.lookbackDays ?? DEFAULT_LOOKBACK_DAYS;
      const cutoffMs = Date.now() - lookbackDays * 86_400_000;
      const log = await readScheduledTaskLog(runtime);
      const filtered = log.filter((entry) => {
        const recordedMs = Date.parse(entry.recordedAt);
        if (!Number.isFinite(recordedMs) || recordedMs < cutoffMs) {
          return false;
        }
        if (
          opts.kinds &&
          opts.kinds.length > 0 &&
          !opts.kinds.includes(entry.kind)
        ) {
          return false;
        }
        if (
          opts.subjectIds &&
          opts.subjectIds.length > 0 &&
          (!entry.subjectId || !opts.subjectIds.includes(entry.subjectId))
        ) {
          return false;
        }
        return true;
      });
      return summarizeEntries(filtered);
    },
  };
}

const EMPTY: ProviderResult = {
  text: "",
  values: { recentTaskStateCount: 0 },
  data: {},
};

export const recentTaskStatesProvider: Provider = {
  name: "recentTaskStates",
  description:
    "Summarizes recent ScheduledTask outcomes (streaks, missed check-ins, " +
    "completion counts) so the planner can answer 'did I check in yesterday?' " +
    "and the quiet-user watcher can flag silence.",
  descriptionCompressed:
    "Recent ScheduledTask outcomes — streaks + summary text.",
  dynamic: true,
  position: 13,
  cacheScope: "turn",
  contexts: ["tasks", "automation"],

  async get(
    runtime: IAgentRuntime,
    message: Memory,
    _state: State,
  ): Promise<ProviderResult> {
    if (!(await hasOwnerAccess(runtime, message))) {
      return EMPTY;
    }
    let summary: RecentTaskStatesSummary;
    try {
      summary = await createRecentTaskStatesProvider(runtime).summarize();
    } catch (error) {
      logger.debug?.(
        "[recent-task-states-provider] summarize failed:",
        String(error),
      );
      return EMPTY;
    }
    if (
      !summary.summary ||
      summary.summary.startsWith("No recent scheduled-task activity")
    ) {
      return EMPTY;
    }
    return {
      text: summary.summary,
      values: {
        recentTaskStateCount: summary.streaks.length,
        notableCount: summary.notable.length,
      },
      data: { recentTaskStates: summary },
    };
  },
};
