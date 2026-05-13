/**
 * `PRIORITIZE` umbrella action — LLM-ranked importance × urgency.
 *
 * Subactions:
 *   - `rank_todos`     — todo items in the owner's life domain
 *   - `rank_threads`   — open inbox / messaging threads
 *   - `rank_decisions` — pending approval queue decisions
 *
 * Loads items via the relevant loader hook, then calls
 * `runtime.useModel(ModelType.TEXT_LARGE)` once with a structured prompt that
 * asks for a JSON ranking by urgency × importance, with a short reasoning
 * string per item.
 *
 * Owner-only.
 */

import type {
  Action,
  ActionExample,
  ActionResult,
  HandlerCallback,
  HandlerOptions,
  IAgentRuntime,
  Memory,
} from "@elizaos/core";
import { logger, ModelType, runWithTrajectoryContext } from "@elizaos/core";
import { hasLifeOpsAccess } from "../lifeops/access.js";

const ACTION_NAME = "PRIORITIZE";

const SUBACTIONS = ["rank_todos", "rank_threads", "rank_decisions"] as const;

type Subaction = (typeof SUBACTIONS)[number];

const SIMILE_NAMES: readonly string[] = [
  "PRIORITIZE",
  "RANK_TODAY",
  "WHAT_MATTERS_MOST",
  "PRIORITIZE_TODAY",
];

type Subject = "todos" | "threads" | "decisions";

const SUBJECT_TO_SUBACTION: Readonly<Record<Subject, Subaction>> = {
  todos: "rank_todos",
  threads: "rank_threads",
  decisions: "rank_decisions",
};

const SUBACTION_TO_SUBJECT: Readonly<Record<Subaction, Subject>> = {
  rank_todos: "todos",
  rank_threads: "threads",
  rank_decisions: "decisions",
};

interface PrioritizeActionParameters {
  subaction?: Subaction | string;
  action?: Subaction | string;
  op?: Subaction | string;
  subject?: Subject | string;
  topN?: number;
  criteria?: string;
}

export interface PrioritizeRankableItem {
  readonly id: string;
  readonly title: string;
  readonly summary?: string;
  readonly dueAt?: string | null;
  readonly metadata?: Record<string, unknown>;
}

export interface PrioritizeRankedItem extends PrioritizeRankableItem {
  readonly rank: number;
  readonly score: number;
  readonly reasoning: string;
}

/**
 * Per-subject loader hooks. Default loaders are empty stubs so tests can
 * mock per-subject inputs without standing up the full service graph.
 */
export interface PrioritizeLoaders {
  loadTodos: (args: {
    runtime: IAgentRuntime;
  }) => Promise<readonly PrioritizeRankableItem[]>;
  loadThreads: (args: {
    runtime: IAgentRuntime;
  }) => Promise<readonly PrioritizeRankableItem[]>;
  loadDecisions: (args: {
    runtime: IAgentRuntime;
  }) => Promise<readonly PrioritizeRankableItem[]>;
}

const defaultLoaders: PrioritizeLoaders = {
  loadTodos: async () => [],
  loadThreads: async () => [],
  loadDecisions: async () => [],
};

let activeLoaders: PrioritizeLoaders = defaultLoaders;

export function setPrioritizeLoaders(next: Partial<PrioritizeLoaders>): void {
  activeLoaders = { ...activeLoaders, ...next };
}

export function __resetPrioritizeLoadersForTests(): void {
  activeLoaders = defaultLoaders;
}

function getParams(
  options: HandlerOptions | undefined,
): PrioritizeActionParameters {
  const raw = (options as HandlerOptions | undefined)?.parameters;
  if (raw && typeof raw === "object") {
    return raw as PrioritizeActionParameters;
  }
  return {};
}

function normalizeSubaction(value: unknown): Subaction | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  const lower = trimmed.toLowerCase();
  return (SUBACTIONS as readonly string[]).includes(lower)
    ? (lower as Subaction)
    : null;
}

function normalizeSubject(value: unknown): Subject | null {
  if (typeof value !== "string") return null;
  const lower = value.trim().toLowerCase();
  if (lower === "todos" || lower === "threads" || lower === "decisions") {
    return lower;
  }
  return null;
}

function resolveSubaction(
  params: PrioritizeActionParameters,
): Subaction | null {
  return (
    normalizeSubaction(params.subaction) ??
    normalizeSubaction(params.action) ??
    normalizeSubaction(params.op) ??
    (() => {
      const subject = normalizeSubject(params.subject);
      return subject ? SUBJECT_TO_SUBACTION[subject] : null;
    })()
  );
}

async function loadItemsForSubaction(
  subaction: Subaction,
  runtime: IAgentRuntime,
): Promise<readonly PrioritizeRankableItem[]> {
  switch (subaction) {
    case "rank_todos":
      return activeLoaders.loadTodos({ runtime });
    case "rank_threads":
      return activeLoaders.loadThreads({ runtime });
    case "rank_decisions":
      return activeLoaders.loadDecisions({ runtime });
  }
}

function buildRankingPrompt(args: {
  subject: Subject;
  items: readonly PrioritizeRankableItem[];
  topN: number;
  criteria?: string;
}): string {
  const data = JSON.stringify(args.items, null, 2);
  const criteriaLine = args.criteria
    ? `\nAdditional criteria from the owner: ${args.criteria}\n`
    : "";
  return `You are ranking the owner's open ${args.subject} by urgency multiplied by importance.

Return strict JSON only:
{
  "ranked": [
    { "id": "<item id>", "score": <0..1 number>, "reasoning": "<short why>" },
    ...
  ]
}

- Include AT MOST ${args.topN} items.
- Score 1.0 means drop-everything-now; 0.0 means could wait indefinitely.
- Sort by descending score.
- Use only the ids that appear in the input data.
- Keep reasoning under 20 words.${criteriaLine}

Items:
${data}`;
}

interface RawRankingEntry {
  readonly id: string;
  readonly score: number;
  readonly reasoning: string;
}

function parseRanking(raw: unknown): readonly RawRankingEntry[] {
  if (typeof raw !== "string") return [];
  const trimmed = raw.trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return [];
  const slice = trimmed.slice(start, end + 1);
  const parsed: unknown = (() => {
    try {
      return JSON.parse(slice);
    } catch {
      return null;
    }
  })();
  if (!parsed || typeof parsed !== "object") return [];
  const rankedRaw = (parsed as { ranked?: unknown }).ranked;
  if (!Array.isArray(rankedRaw)) return [];
  const entries: RawRankingEntry[] = [];
  for (const entry of rankedRaw) {
    if (!entry || typeof entry !== "object") continue;
    const obj = entry as Record<string, unknown>;
    const id = typeof obj.id === "string" ? obj.id : null;
    const score = typeof obj.score === "number" ? obj.score : null;
    const reasoning = typeof obj.reasoning === "string" ? obj.reasoning : "";
    if (!id || score === null) continue;
    entries.push({ id, score, reasoning });
  }
  return entries;
}

function applyRanking(
  items: readonly PrioritizeRankableItem[],
  ranking: readonly RawRankingEntry[],
  topN: number,
): readonly PrioritizeRankedItem[] {
  const itemMap = new Map(items.map((item) => [item.id, item]));
  const sorted = [...ranking].sort((a, b) => b.score - a.score);
  const ranked: PrioritizeRankedItem[] = [];
  for (const entry of sorted) {
    const source = itemMap.get(entry.id);
    if (!source) continue;
    ranked.push({
      ...source,
      rank: ranked.length + 1,
      score: entry.score,
      reasoning: entry.reasoning,
    });
    if (ranked.length >= topN) break;
  }
  return ranked;
}

const examples: ActionExample[][] = [
  [
    { name: "{{name1}}", content: { text: "What should I focus on today?" } },
    {
      name: "{{agentName}}",
      content: {
        text: "Ranked your top todos by urgency × importance.",
        action: ACTION_NAME,
      },
    },
  ],
  [
    {
      name: "{{name1}}",
      content: { text: "Which threads need my attention first?" },
    },
    {
      name: "{{agentName}}",
      content: {
        text: "Ranked your open threads by priority.",
        action: ACTION_NAME,
      },
    },
  ],
];

export const prioritizeAction: Action & {
  suppressPostActionContinuation?: boolean;
} = {
  name: ACTION_NAME,
  similes: SIMILE_NAMES.slice(),
  tags: [
    "domain:focus",
    "capability:read",
    "capability:rank",
    "surface:internal",
  ],
  description:
    "Rank the owner's open todos, message threads, or pending decisions by urgency × importance via an LLM compose pass. Subactions: rank_todos, rank_threads, rank_decisions.",
  descriptionCompressed:
    "prioritize: rank_todos|rank_threads|rank_decisions; topN ranking by urgency × importance",
  routingHint:
    'prioritization intent ("what should I focus on", "rank my today", "which thread first", "what matters most") -> PRIORITIZE; do not use for a plain list (that\'s OWNER_TODOS.list / MESSAGE.list_inbox)',
  contexts: ["focus", "tasks", "inbox", "approvals"],
  roleGate: { minRole: "OWNER" },
  suppressPostActionContinuation: true,
  validate: async (runtime, message) => hasLifeOpsAccess(runtime, message),
  parameters: [
    {
      name: "action",
      description:
        "Canonical prioritization operation: rank_todos | rank_threads | rank_decisions.",
      schema: { type: "string" as const, enum: [...SUBACTIONS] },
    },
    {
      name: "subject",
      description:
        "Alternative selector: todos | threads | decisions. Maps onto the matching subaction.",
      schema: {
        type: "string" as const,
        enum: ["todos", "threads", "decisions"],
      },
    },
    {
      name: "topN",
      description: "How many items to return at the top. Defaults to 5.",
      schema: { type: "number" as const },
    },
    {
      name: "criteria",
      description:
        "Free-form additional weighting criteria the owner wants applied.",
      schema: { type: "string" as const },
    },
  ],
  examples,
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state,
    options,
    callback: HandlerCallback | undefined,
  ): Promise<ActionResult> => {
    if (!(await hasLifeOpsAccess(runtime, message))) {
      const text = "Prioritization is restricted to the owner.";
      await callback?.({ text });
      return { text, success: false, data: { error: "PERMISSION_DENIED" } };
    }

    const params = getParams(options);
    const subaction = resolveSubaction(params);
    if (!subaction) {
      return {
        success: false,
        text: "Tell me what to rank: rank_todos, rank_threads, or rank_decisions.",
        data: { error: "MISSING_SUBACTION" },
      };
    }

    const subject = SUBACTION_TO_SUBJECT[subaction];
    const topN =
      typeof params.topN === "number" && params.topN > 0
        ? Math.floor(params.topN)
        : 5;

    const items = await loadItemsForSubaction(subaction, runtime);
    if (items.length === 0) {
      const text = `No open ${subject} to rank.`;
      logger.info(`[PRIORITIZE] ${subaction} empty topN=${topN}`);
      await callback?.({ text, source: "action", action: ACTION_NAME });
      return {
        success: true,
        text,
        data: {
          subaction,
          subject,
          ranked: [] as readonly PrioritizeRankedItem[],
        },
      };
    }

    if (typeof runtime.useModel !== "function") {
      logger.warn(
        `[PRIORITIZE] ${subaction} runtime.useModel unavailable, returning natural order`,
      );
      const fallbackRanked = items
        .slice(0, topN)
        .map<PrioritizeRankedItem>((item, index) => ({
          ...item,
          rank: index + 1,
          score: 0,
          reasoning: "model unavailable; preserved input order",
        }));
      const text = `Ranked ${fallbackRanked.length} ${subject} (model unavailable, used input order).`;
      await callback?.({ text, source: "action", action: ACTION_NAME });
      return {
        success: true,
        text,
        data: {
          subaction,
          subject,
          ranked: fallbackRanked,
          warning: "MODEL_UNAVAILABLE",
        },
      };
    }

    const prompt = buildRankingPrompt({
      subject,
      items,
      topN,
      criteria: params.criteria,
    });

    let raw: unknown;
    try {
      raw = await runWithTrajectoryContext(
        { purpose: "lifeops-prioritize" },
        () => runtime.useModel(ModelType.TEXT_LARGE, { prompt }),
      );
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      logger.error(`[PRIORITIZE] ${subaction} model call failed: ${detail}`);
      return {
        success: false,
        text: `I couldn't rank your ${subject} — the language model call failed.`,
        data: {
          subaction,
          subject,
          error: "MODEL_CALL_FAILED",
          detail,
        },
      };
    }

    const parsed = parseRanking(raw);
    const ranked = applyRanking(items, parsed, topN);

    logger.info(
      `[PRIORITIZE] ${subaction} ranked=${ranked.length} items=${items.length} topN=${topN}`,
    );

    const text =
      ranked.length === 0
        ? `Ranked 0 ${subject} — model produced no valid entries.`
        : `Ranked top ${ranked.length} ${subject} by urgency × importance.`;

    await callback?.({ text, source: "action", action: ACTION_NAME });

    return {
      success: true,
      text,
      data: {
        subaction,
        subject,
        ranked,
        ...(ranked.length === 0 ? { warning: "EMPTY_RANKING" } : {}),
      },
    };
  },
};
