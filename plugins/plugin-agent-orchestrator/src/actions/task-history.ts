import type {
  Action,
  ActionResult,
  HandlerCallback,
  HandlerOptions,
  IAgentRuntime,
  Memory,
} from "@elizaos/core";
import { getCoordinator } from "../services/pty-service.js";
import { requireTaskAgentAccess } from "../services/task-policy.js";
import type {
  ListTaskThreadsOptions,
  TaskThreadStatus,
} from "../services/task-registry.js";

const deprecatedActionWarnings = new Set<string>();

function warnDeprecatedSpawnSurface(
  actionName: string,
  replacement: string,
): void {
  if (deprecatedActionWarnings.has(actionName)) return;
  deprecatedActionWarnings.add(actionName);
  console.warn(
    `[plugin-agent-orchestrator] ${actionName} is deprecated. Use ${replacement} from @elizaos/plugin-acpx instead.`,
  );
}
type HistoryMetric = "list" | "count" | "detail";
type HistoryWindow =
  | "active"
  | "today"
  | "yesterday"
  | "last_7_days"
  | "last_30_days";

function textValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function startOfDay(date: Date): Date {
  const copy = new Date(date);
  copy.setHours(0, 0, 0, 0);
  return copy;
}

function endOfDay(date: Date): Date {
  const copy = new Date(date);
  copy.setHours(23, 59, 59, 999);
  return copy;
}

function formatDate(date: Date): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  }).format(date);
}

function inferMetric(text: string, value?: string): HistoryMetric {
  const normalized = value?.trim().toLowerCase();
  if (
    normalized === "count" ||
    normalized === "detail" ||
    normalized === "list"
  ) {
    return normalized;
  }
  if (/\bhow many\b|\bcount\b/i.test(text)) return "count";
  if (/\bshow me\b|\bgive me\b|\blist\b|\bwhat are\b/i.test(text))
    return "list";
  return "detail";
}

function inferStatuses(
  text: string,
  rawStatuses?: string[],
): TaskThreadStatus[] | undefined {
  if (rawStatuses && rawStatuses.length > 0) {
    return rawStatuses as TaskThreadStatus[];
  }
  const statuses = new Set<TaskThreadStatus>();
  if (/\bactive\b|\bright now\b|\bworking on right now\b/i.test(text)) {
    statuses.add("active");
  }
  if (/\bblocked\b/i.test(text)) {
    statuses.add("blocked");
  }
  if (/\binterrupted\b|\bpaused\b/i.test(text)) {
    statuses.add("interrupted");
  }
  if (/\bdone\b|\bcompleted\b|\bfinished\b/i.test(text)) {
    statuses.add("done");
  }
  if (/\bfailed\b|\berror\b/i.test(text)) {
    statuses.add("failed");
  }
  return statuses.size > 0 ? Array.from(statuses) : undefined;
}

function inferWindow(text: string, raw?: string): HistoryWindow | undefined {
  const normalized = raw?.trim().toLowerCase();
  if (
    normalized === "active" ||
    normalized === "today" ||
    normalized === "yesterday" ||
    normalized === "last_7_days" ||
    normalized === "last_30_days"
  ) {
    return normalized;
  }
  if (/\bright now\b|\bcurrently\b|\bactive\b/i.test(text)) return "active";
  if (/\byesterday\b/i.test(text)) return "yesterday";
  if (/\blast week\b|\blast 7 days\b|\bin the last week\b/i.test(text)) {
    return "last_7_days";
  }
  if (/\blast month\b|\blast 30 days\b/i.test(text)) return "last_30_days";
  if (/\btoday\b/i.test(text)) return "today";
  return undefined;
}

function inferSearch(text: string, raw?: string): string | undefined {
  if (raw?.trim()) return raw.trim();
  const quoted =
    text.match(/"([^"]{3,120})"/)?.[1] ?? text.match(/'([^']{3,120})'/)?.[1];
  if (quoted) return quoted.trim();
  const topical =
    text.match(/\bworking on\s+(.+?)(?:[?.!,]|$)/i)?.[1] ??
    text.match(
      /\ball tasks where we were working on\s+(.+?)(?:[?.!,]|$)/i,
    )?.[1];
  return topical?.trim();
}

function buildWindowFilters(window: HistoryWindow | undefined): {
  latestActivityAfter?: number;
  latestActivityBefore?: number;
  label?: string;
} {
  const now = new Date();
  if (window === "active") {
    return { label: "active tasks right now" };
  }
  if (window === "today") {
    const start = startOfDay(now);
    const end = endOfDay(now);
    return {
      latestActivityAfter: start.getTime(),
      latestActivityBefore: end.getTime(),
      label: `${formatDate(start)} through ${formatDate(end)}`,
    };
  }
  if (window === "yesterday") {
    const start = startOfDay(new Date(now.getTime() - 24 * 60 * 60 * 1000));
    const end = endOfDay(start);
    return {
      latestActivityAfter: start.getTime(),
      latestActivityBefore: end.getTime(),
      label: `${formatDate(start)} through ${formatDate(end)}`,
    };
  }
  if (window === "last_7_days") {
    const start = startOfDay(new Date(now.getTime() - 6 * 24 * 60 * 60 * 1000));
    return {
      latestActivityAfter: start.getTime(),
      latestActivityBefore: now.getTime(),
      label: `${formatDate(start)} through ${formatDate(now)}`,
    };
  }
  if (window === "last_30_days") {
    const start = startOfDay(
      new Date(now.getTime() - 29 * 24 * 60 * 60 * 1000),
    );
    return {
      latestActivityAfter: start.getTime(),
      latestActivityBefore: now.getTime(),
      label: `${formatDate(start)} through ${formatDate(now)}`,
    };
  }
  return {};
}

function renderThreadLine(entry: {
  title: string;
  status: string;
  latestActivityAt?: number | null;
  summary?: string;
}): string {
  const activity =
    typeof entry.latestActivityAt === "number"
      ? new Date(entry.latestActivityAt).toLocaleString("en-US")
      : "unknown time";
  return `- ${entry.title} [${entry.status}] (${activity})${entry.summary ? `: ${entry.summary}` : ""}`;
}

/**
 * @deprecated The plugin-agent-orchestrator PTY spawn surface is deprecated.
 * Use @elizaos/plugin-acpx session history/list actions instead. This action remains during the migration window.
 */
export const taskHistoryAction: Action = {
  name: "TASK_HISTORY",
  similes: [
    "LIST_TASK_HISTORY",
    "GET_TASK_HISTORY",
    "SHOW_TASKS",
    "COUNT_TASKS",
    "TASK_STATUS_HISTORY",
  ],
  description:
    "Query coordinator task history without stuffing raw transcripts into model context. Use this for active work, yesterday/last-week summaries, topic search, counts, and thread detail lookup.",
  descriptionCompressed:
    "Query task history: active work, summaries, search, thread details.",
  examples: [
    [
      {
        name: "{{user1}}",
        content: { text: "What are you working on right now?" },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "I'll check the coordinator's current task state.",
          action: "TASK_HISTORY",
        },
      },
    ],
    [
      {
        name: "{{user1}}",
        content: {
          text: "In the last week, give me all tasks where we were working on the Discord connector.",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "I'll query the task history for that date range and topic.",
          action: "TASK_HISTORY",
        },
      },
    ],
  ],
  validate: async (runtime: IAgentRuntime): Promise<boolean> => {
    return Boolean(getCoordinator(runtime));
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state,
    options?: HandlerOptions,
    callback?: HandlerCallback,
  ): Promise<ActionResult | undefined> => {
    warnDeprecatedSpawnSurface(
      "taskHistoryAction",
      "@elizaos/plugin-acpx session history/list actions",
    );
    const access = await requireTaskAgentAccess(runtime, message, "interact");
    if (!access.allowed) {
      if (callback) {
        await callback({ text: access.reason });
      }
      return { success: false, error: "FORBIDDEN", text: access.reason };
    }

    const coordinator = getCoordinator(runtime);
    if (!coordinator) {
      if (callback) {
        await callback({ text: "Coordinator is not available." });
      }
      return { success: false, error: "SERVICE_UNAVAILABLE" };
    }

    const params =
      (options?.parameters as Record<string, unknown> | undefined) ?? {};
    const content = (message.content ?? {}) as Record<string, unknown>;
    const text = typeof content.text === "string" ? content.text : "";

    const metric = inferMetric(
      text,
      textValue(params.metric) ?? textValue(content.metric),
    );
    const statuses = inferStatuses(
      text,
      Array.isArray(params.statuses)
        ? params.statuses.filter(
            (value): value is string => typeof value === "string",
          )
        : Array.isArray(content.statuses)
          ? content.statuses.filter(
              (value): value is string => typeof value === "string",
            )
          : undefined,
    );
    const window = inferWindow(
      text,
      textValue(params.window) ?? textValue(content.window),
    );
    const search = inferSearch(
      text,
      textValue(params.search) ?? textValue(content.search),
    );
    const limitRaw = Number(
      params.limit ?? content.limit ?? (metric === "detail" ? 1 : 10),
    );
    const limit =
      Number.isFinite(limitRaw) && limitRaw > 0 ? Math.trunc(limitRaw) : 10;
    const includeArchived =
      (params.includeArchived as boolean | undefined) ??
      (content.includeArchived as boolean | undefined) ??
      false;
    const windowFilters = buildWindowFilters(window);

    const threadFilters: ListTaskThreadsOptions = {
      includeArchived,
      ...(statuses && statuses.length > 0 ? { statuses } : {}),
      ...(windowFilters.latestActivityAfter
        ? { latestActivityAfter: windowFilters.latestActivityAfter }
        : {}),
      ...(windowFilters.latestActivityBefore
        ? { latestActivityBefore: windowFilters.latestActivityBefore }
        : {}),
      ...(search ? { search } : {}),
      ...(window === "active" ? { hasActiveSession: true } : {}),
      limit,
    };

    const [count, threads] = await Promise.all([
      coordinator.countTaskThreads(threadFilters),
      coordinator.listTaskThreads(threadFilters),
    ]);

    const summaryWindow =
      windowFilters.label ??
      (window === "active"
        ? "right now"
        : includeArchived
          ? "all recorded time"
          : "recent task history");
    const summaryTopic = search ? ` for "${search}"` : "";
    const summaryStatus =
      statuses && statuses.length > 0
        ? ` with status ${statuses.join(", ")}`
        : "";

    let responseText = "";
    if (metric === "count") {
      responseText = `I found ${count} task${count === 1 ? "" : "s"} ${summaryWindow}${summaryTopic}${summaryStatus}.`;
    } else if (threads.length === 0) {
      responseText = `I did not find any tasks ${summaryWindow}${summaryTopic}${summaryStatus}.`;
    } else if (metric === "detail" && threads[0]) {
      const thread = await coordinator.getTaskThread(threads[0].id);
      responseText = [
        `The most relevant task is "${threads[0].title}" [${threads[0].status}].`,
        thread?.summary ? `Summary: ${thread.summary}` : "",
        thread?.latestWorkdir ? `Workspace: ${thread.latestWorkdir}` : "",
        thread?.latestRepo ? `Repository: ${thread.latestRepo}` : "",
        typeof thread?.latestActivityAt === "number"
          ? `Latest activity: ${new Date(thread.latestActivityAt).toLocaleString("en-US")}`
          : "",
      ]
        .filter(Boolean)
        .join("\n");
    } else {
      responseText = [
        `I found ${count} task${count === 1 ? "" : "s"} ${summaryWindow}${summaryTopic}${summaryStatus}.`,
        ...threads.slice(0, limit).map(renderThreadLine),
      ].join("\n");
    }

    if (callback) {
      await callback({ text: responseText });
    }
    return {
      success: true,
      text: responseText,
      data: {
        filters: threadFilters,
        window,
        count,
        threadIds: threads.map((thread) => thread.id),
      },
    };
  },
  parameters: [
    {
      name: "metric",
      description: "Query mode: list, count, or detail.",
      required: false,
      schema: { type: "string" as const, enum: ["list", "count", "detail"] },
    },
    {
      name: "window",
      description: "Relative time window for the query.",
      required: false,
      schema: {
        type: "string" as const,
        enum: ["active", "today", "yesterday", "last_7_days", "last_30_days"],
      },
    },
    {
      name: "search",
      description: "Topic or free-text search string to match task threads.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "statuses",
      description: "Optional status filter list.",
      required: false,
      schema: { type: "array" as const, items: { type: "string" as const } },
    },
    {
      name: "limit",
      description: "Maximum number of thread summaries to return.",
      required: false,
      schema: { type: "number" as const },
    },
    {
      name: "includeArchived",
      description: "Whether archived threads should be included.",
      required: false,
      schema: { type: "boolean" as const },
    },
  ],
};
