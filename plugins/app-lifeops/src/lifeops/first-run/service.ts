/**
 * `FirstRunService` — orchestrator for the first-run capability.
 *
 * Owns:
 *   - the lifecycle state machine (`pending` → `in_progress` → `complete`)
 *     via `FirstRunStateStore`
 *   - writes to `OwnerFactStore` (interim wrapper, W2-E swap target)
 *   - emission of the defaults pack into the `ScheduledTaskRunner`
 *   - the replay path (re-run without destroying tasks)
 *
 * The runner is **injected** so the wave-1 boundary stays clean: if W1-A's
 * production runner is registered on the runtime by the time the action
 * fires, this service uses it; otherwise it falls back to an in-memory
 * recorder that is sufficient for unit/integration tests.
 *
 * Move target for `service-mixin-definitions.ts`'s legacy
 * `checkAndOfferSeeding` / `applySeedRoutines`: those methods are deprecated
 * once first-run lands. The legacy entry points stay on the mixin for
 * backwards compat but delegate to this service.
 */

import type { IAgentRuntime } from "@elizaos/core";
import type { ScheduledTask, ScheduledTaskInput } from "../wave1-types.js";
import {
  buildDefaultsPack,
  deriveMorningWindow,
  parseWakeTime,
} from "./defaults.js";
import {
  CUSTOMIZE_CATEGORIES,
  type CustomizeAnswers,
  type CustomizeCategory,
  DEFAULT_EVENING_WINDOW,
  DEFAULT_MORNING_WINDOW,
  parseCategories,
  parsePreferredName,
  parseRelationships,
  parseTimeWindow,
  parseTimezone,
  type RelationshipAnswerEntry,
  validateChannel,
} from "./questions.js";
import { partialAnswersFromFacts } from "./replay.js";
import {
  createFirstRunStateStore,
  createOwnerFactStore,
  type FirstRunRecord,
  type FirstRunStateStore,
  type OwnerFactStore,
} from "./state.js";
import { asCacheRuntime } from "../runtime-cache.js";

// --- Runner injection ------------------------------------------------------

export interface ScheduledTaskRunnerLike {
  schedule(task: ScheduledTaskInput): Promise<ScheduledTask>;
}

/**
 * Runtime-side hook used by W1-A to expose the production runner. The plugin
 * `init` registers an instance via `setScheduledTaskRunner`; the first-run
 * service calls `getScheduledTaskRunner` to fetch it. When unset, the service
 * uses the in-memory fallback which is sufficient for the wave-1 e2e tests.
 */
let registeredRunner: ScheduledTaskRunnerLike | null = null;

export function setScheduledTaskRunner(
  runner: ScheduledTaskRunnerLike | null,
): void {
  registeredRunner = runner;
}

export function getScheduledTaskRunner(): ScheduledTaskRunnerLike | null {
  return registeredRunner;
}

interface CachedTaskRecord {
  taskId: string;
  input: ScheduledTaskInput;
  scheduledAt: string;
}

const FALLBACK_RUNNER_CACHE_KEY = "eliza:lifeops:first-run:fallback-tasks:v1";

class FallbackInMemoryRunner implements ScheduledTaskRunnerLike {
  constructor(private readonly runtime: IAgentRuntime) {}
  async schedule(task: ScheduledTaskInput): Promise<ScheduledTask> {
    const cache = asCacheRuntime(this.runtime);
    const taskId =
      task.idempotencyKey ??
      `first-run-task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const scheduled: ScheduledTask = {
      ...task,
      taskId,
      state: { status: "scheduled", followupCount: 0 },
    };
    const stored =
      (await cache.getCache<CachedTaskRecord[]>(FALLBACK_RUNNER_CACHE_KEY)) ??
      [];
    const filtered = task.idempotencyKey
      ? stored.filter(
          (entry) => entry.input.idempotencyKey !== task.idempotencyKey,
        )
      : stored.slice();
    filtered.push({
      taskId,
      input: task,
      scheduledAt: new Date().toISOString(),
    });
    await cache.setCache<CachedTaskRecord[]>(
      FALLBACK_RUNNER_CACHE_KEY,
      filtered,
    );
    return scheduled;
  }
}

export async function readFallbackScheduledTasks(
  runtime: IAgentRuntime,
): Promise<CachedTaskRecord[]> {
  const cache = asCacheRuntime(runtime);
  const stored = await cache.getCache<CachedTaskRecord[]>(
    FALLBACK_RUNNER_CACHE_KEY,
  );
  return Array.isArray(stored) ? stored.slice() : [];
}

export async function clearFallbackScheduledTasks(
  runtime: IAgentRuntime,
): Promise<void> {
  const cache = asCacheRuntime(runtime);
  await cache.deleteCache(FALLBACK_RUNNER_CACHE_KEY);
}

// --- Service ---------------------------------------------------------------

export interface FirstRunRunResult {
  status: "ok" | "needs_more_input" | "already_complete";
  record: FirstRunRecord;
  facts: Awaited<ReturnType<OwnerFactStore["read"]>>;
  scheduledTasks: ScheduledTask[];
  /** Question id awaiting an answer (only set when status = needs_more_input). */
  awaitingQuestion?: string;
  /** Human-readable message the action surfaces back. */
  message: string;
  /** Warnings collected during the flow (e.g. channel-validation fallback). */
  warnings: string[];
}

export interface DefaultsPathInput {
  /** Free-text wake time, e.g. "6am", "07:30". Required on first invocation. */
  wakeTime?: string;
  /** IANA timezone; defaults to runtime / system value if absent. */
  timezone?: string;
  /** Optional notification channel; defaults to in_app. */
  channel?: string;
}

export interface CustomizePathInput {
  preferredName?: string;
  timezone?: string;
  morningWindow?: { startLocal: string; endLocal: string };
  eveningWindow?: { startLocal: string; endLocal: string };
  categories?: string[];
  channel?: string;
  relationships?: Array<{ name: string; cadenceDays: number }>;
}

export interface ReplayPathInput {
  /** Allows the same answer keys as customize, but only applied when present. */
  preferredName?: string;
  timezone?: string;
  morningWindow?: { startLocal: string; endLocal: string };
  eveningWindow?: { startLocal: string; endLocal: string };
  categories?: string[];
  channel?: string;
  relationships?: Array<{ name: string; cadenceDays: number }>;
}

export class FirstRunService {
  private readonly stateStore: FirstRunStateStore;
  private readonly factStore: OwnerFactStore;
  constructor(
    private readonly runtime: IAgentRuntime,
    options?: {
      stateStore?: FirstRunStateStore;
      factStore?: OwnerFactStore;
      runner?: ScheduledTaskRunnerLike;
    },
  ) {
    this.stateStore = options?.stateStore ?? createFirstRunStateStore(runtime);
    this.factStore = options?.factStore ?? createOwnerFactStore(runtime);
    if (options?.runner) {
      // Caller-supplied runner trumps the registered one (used by tests).
      this.runnerOverride = options.runner;
    }
  }
  private runnerOverride: ScheduledTaskRunnerLike | null = null;

  private resolveRunner(): ScheduledTaskRunnerLike {
    return (
      this.runnerOverride ??
      registeredRunner ??
      new FallbackInMemoryRunner(this.runtime)
    );
  }

  async readState(): Promise<FirstRunRecord> {
    return this.stateStore.read();
  }

  async readFacts(): ReturnType<OwnerFactStore["read"]> {
    return this.factStore.read();
  }

  /**
   * Path A: defaults. Asks ONE question (wake time) before scheduling. The
   * action invokes `runDefaultsPath` once with no `wakeTime`, gets back a
   * `needs_more_input` result and the question text, then re-invokes with
   * the parsed answer.
   */
  async runDefaultsPath(input: DefaultsPathInput): Promise<FirstRunRunResult> {
    let record = await this.stateStore.read();
    if (record.status === "complete") {
      return {
        status: "already_complete",
        record,
        facts: await this.factStore.read(),
        scheduledTasks: [],
        message:
          "First-run already completed. Use the replay path to re-confirm settings.",
        warnings: [],
      };
    }
    if (record.path !== "defaults" || record.status === "pending") {
      record = await this.stateStore.begin("defaults");
    }

    const wakeRaw =
      typeof input.wakeTime === "string" && input.wakeTime.trim().length > 0
        ? input.wakeTime
        : typeof record.partialAnswers.wakeTime === "string"
          ? (record.partialAnswers.wakeTime as string)
          : undefined;

    if (!wakeRaw) {
      return {
        status: "needs_more_input",
        record,
        facts: await this.factStore.read(),
        scheduledTasks: [],
        awaitingQuestion: "wakeTime",
        message: "What time do you usually wake up?",
        warnings: [],
      };
    }

    const parsed = parseWakeTime(wakeRaw);
    if (!parsed) {
      return {
        status: "needs_more_input",
        record,
        facts: await this.factStore.read(),
        scheduledTasks: [],
        awaitingQuestion: "wakeTime",
        message:
          "I didn't catch that wake time. Try something like '6am', '07:30', or 'noon'.",
        warnings: [],
      };
    }
    record = await this.stateStore.recordAnswer("wakeTime", parsed);

    const morningWindow = deriveMorningWindow(parsed);
    const timezone = parseTimezone(input.timezone) ?? this.resolveTimezone();
    const channelValidation = validateChannel(
      input.channel ?? "in_app",
      this.runtime,
    );
    const facts = await this.factStore.update({
      morningWindow,
      timezone,
      eveningWindow: DEFAULT_EVENING_WINDOW,
      preferredNotificationChannel: channelValidation.channel,
    });

    const pack = buildDefaultsPack({
      morningWindow,
      timezone,
      agentId: this.runtime.agentId,
      channel: channelValidation.channel,
    });
    const runner = this.resolveRunner();
    const scheduledTasks: ScheduledTask[] = [];
    for (const input of pack) {
      scheduledTasks.push(await runner.schedule(input));
    }

    const completed = await this.stateStore.complete();

    return {
      status: "ok",
      record: completed,
      facts,
      scheduledTasks,
      message: this.formatDefaultsCompleteMessage(scheduledTasks.length),
      warnings: channelValidation.warning ? [channelValidation.warning] : [],
    };
  }

  /**
   * Path B: customize. Walks through the 5-question set, persisting each
   * answer to `partialAnswers`. Returns `needs_more_input` until every
   * required-and-conditional question has an answer.
   */
  async runCustomizePath(
    input: CustomizePathInput,
  ): Promise<FirstRunRunResult> {
    let record = await this.stateStore.read();
    if (record.status === "complete") {
      return {
        status: "already_complete",
        record,
        facts: await this.factStore.read(),
        scheduledTasks: [],
        message:
          "First-run already completed. Use the replay path to re-confirm settings.",
        warnings: [],
      };
    }
    if (record.path !== "customize") {
      record = await this.stateStore.begin("customize");
    }

    const merged = mergeCustomizeAnswers(record.partialAnswers, input);
    record = await persistCustomizePartials(this.stateStore, merged);

    const next = nextCustomizeQuestion(merged);
    if (next) {
      return {
        status: "needs_more_input",
        record,
        facts: await this.factStore.read(),
        scheduledTasks: [],
        awaitingQuestion: next.id,
        message: next.prompt,
        warnings: [],
      };
    }

    const finalized = finalizeCustomizeAnswers(merged, this.runtime);

    const factsPatch: Parameters<OwnerFactStore["update"]>[0] = {
      preferredName: finalized.preferredName,
      timezone: finalized.timezone,
      morningWindow: finalized.morningWindow,
      eveningWindow: finalized.eveningWindow,
      preferredNotificationChannel: finalized.channel,
    };
    const facts = await this.factStore.update(factsPatch);

    const pack = buildDefaultsPack({
      morningWindow: finalized.morningWindow,
      timezone: finalized.timezone,
      agentId: this.runtime.agentId,
      channel: finalized.channel,
    });
    const runner = this.resolveRunner();
    const scheduledTasks: ScheduledTask[] = [];
    for (const input of pack) {
      scheduledTasks.push(await runner.schedule(input));
    }
    // Categories that gate followups would create per-relationship watcher
    // tasks in W1-D's followup-starter pack. Here we just record the
    // selection on the answers; the W1-D pack reads those facts at boot.

    const completed = await this.stateStore.complete();
    const warnings: string[] = [];
    if (finalized.channelWarning) {
      warnings.push(finalized.channelWarning);
    }
    return {
      status: "ok",
      record: completed,
      facts,
      scheduledTasks,
      message: this.formatCustomizeCompleteMessage(
        finalized,
        scheduledTasks.length,
      ),
      warnings,
    };
  }

  /**
   * Replay. Per `GAP_ASSESSMENT.md` §8.14: keeps existing tasks intact (the
   * runner upserts by `idempotencyKey`); only OwnerFactStore facts the
   * questions touch are updated.
   */
  async runReplayPath(input: ReplayPathInput): Promise<FirstRunRunResult> {
    let record = await this.stateStore.read();
    record = await this.stateStore.begin("replay");
    const currentFacts = await this.factStore.read();
    const partial = partialAnswersFromFacts(currentFacts);
    const merged = mergeCustomizeAnswers(
      {
        ...partial,
        ...record.partialAnswers,
      },
      input,
    );
    record = await persistCustomizePartials(this.stateStore, merged);

    const next = nextCustomizeQuestion(merged);
    if (next) {
      return {
        status: "needs_more_input",
        record,
        facts: currentFacts,
        scheduledTasks: [],
        awaitingQuestion: next.id,
        message: next.prompt,
        warnings: [],
      };
    }

    const finalized = finalizeCustomizeAnswers(merged, this.runtime);
    const factsPatch: Parameters<OwnerFactStore["update"]>[0] = {
      preferredName: finalized.preferredName,
      timezone: finalized.timezone,
      morningWindow: finalized.morningWindow,
      eveningWindow: finalized.eveningWindow,
      preferredNotificationChannel: finalized.channel,
    };
    const facts = await this.factStore.update(factsPatch);

    // Re-emit the defaults pack with the same idempotency keys so the runner
    // upserts in place. Existing user-authored tasks (different idempotency
    // keys) are untouched.
    const pack = buildDefaultsPack({
      morningWindow: finalized.morningWindow,
      timezone: finalized.timezone,
      agentId: this.runtime.agentId,
      channel: finalized.channel,
    });
    const runner = this.resolveRunner();
    const scheduledTasks: ScheduledTask[] = [];
    for (const taskInput of pack) {
      scheduledTasks.push(await runner.schedule(taskInput));
    }

    const completed = await this.stateStore.complete();
    const warnings: string[] = [];
    if (finalized.channelWarning) warnings.push(finalized.channelWarning);
    return {
      status: "ok",
      record: completed,
      facts,
      scheduledTasks,
      message: "Settings refreshed. Existing scheduled tasks were preserved.",
      warnings,
    };
  }

  /** Used by `LIFEOPS.wipe`. Clears state but does NOT rerun first-run. */
  async resetState(): Promise<void> {
    await this.stateStore.reset();
  }

  private resolveTimezone(): string {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    } catch {
      return "UTC";
    }
  }

  private formatDefaultsCompleteMessage(taskCount: number): string {
    return `Defaults applied — ${taskCount} reminders scheduled (gm, gn, daily check-in, morning brief).`;
  }

  private formatCustomizeCompleteMessage(
    answers: FinalizedCustomizeAnswers,
    taskCount: number,
  ): string {
    const name = answers.preferredName ? `, ${answers.preferredName}` : "";
    return `Setup complete${name} — ${taskCount} reminders scheduled. Channel: ${answers.channel}${
      answers.channelFallbackToInApp ? " (fallback)" : ""
    }.`;
  }
}

// --- Customize internals --------------------------------------------------

function mergeCustomizeAnswers(
  current: Record<string, unknown>,
  patch: CustomizePathInput,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...current };
  if (typeof patch.preferredName === "string") {
    next.preferredName = patch.preferredName;
  }
  if (typeof patch.timezone === "string") {
    next.timezone = patch.timezone;
  }
  if (patch.morningWindow) next.morningWindow = patch.morningWindow;
  if (patch.eveningWindow) next.eveningWindow = patch.eveningWindow;
  if (Array.isArray(patch.categories)) next.categories = patch.categories;
  if (typeof patch.channel === "string") next.channel = patch.channel;
  if (Array.isArray(patch.relationships)) {
    next.relationships = patch.relationships;
  }
  return next;
}

async function persistCustomizePartials(
  store: FirstRunStateStore,
  merged: Record<string, unknown>,
): Promise<FirstRunRecord> {
  let last: FirstRunRecord = await store.read();
  for (const [key, value] of Object.entries(merged)) {
    if (last.partialAnswers[key] === value) continue;
    last = await store.recordAnswer(key, value);
  }
  return last;
}

interface CustomizeQuestionState {
  id:
    | "preferredName"
    | "timezoneAndWindows"
    | "categories"
    | "channel"
    | "relationships";
  prompt: string;
}

function nextCustomizeQuestion(
  answers: Record<string, unknown>,
): CustomizeQuestionState | null {
  if (!parsePreferredName(answers.preferredName)) {
    return {
      id: "preferredName",
      prompt: "What should I call you?",
    };
  }
  if (
    !parseTimezone(answers.timezone) ||
    !parseTimeWindow(answers.morningWindow) ||
    !parseTimeWindow(answers.eveningWindow)
  ) {
    return {
      id: "timezoneAndWindows",
      prompt:
        "What time zone are you in, and what counts as your morning / evening? (Defaults: morning 06:00–11:00, evening 18:00–22:00.)",
    };
  }
  if (parseCategories(answers.categories) === null) {
    return {
      id: "categories",
      prompt: `Which categories sound useful to enable now? (multi-select: ${CUSTOMIZE_CATEGORIES.join(", ")})`,
    };
  }
  const channelRaw = answers.channel;
  if (typeof channelRaw !== "string" || channelRaw.trim().length === 0) {
    return {
      id: "channel",
      prompt:
        "Where do you want me to nudge you? (in_app, push, imessage, discord, telegram)",
    };
  }
  const categories = parseCategories(answers.categories) ?? [];
  if (
    categories.includes("follow-ups") &&
    parseRelationships(answers.relationships) === null
  ) {
    return {
      id: "relationships",
      prompt:
        "List 3–5 important relationships and a default cadence (e.g. 'Pat — 14 days; Sam — weekly').",
    };
  }
  return null;
}

interface FinalizedCustomizeAnswers extends CustomizeAnswers {
  channelFallbackToInApp: boolean;
}

function finalizeCustomizeAnswers(
  answers: Record<string, unknown>,
  runtime: IAgentRuntime,
): FinalizedCustomizeAnswers {
  const preferredName = parsePreferredName(answers.preferredName) ?? "";
  const timezone = parseTimezone(answers.timezone) ?? "UTC";
  const morningWindow =
    parseTimeWindow(answers.morningWindow) ?? DEFAULT_MORNING_WINDOW;
  const eveningWindow =
    parseTimeWindow(answers.eveningWindow) ?? DEFAULT_EVENING_WINDOW;
  const categories = parseCategories(answers.categories) ?? [];
  const validation = validateChannel(answers.channel, runtime);
  const relationships = parseRelationships(answers.relationships) ?? undefined;
  const finalized: FinalizedCustomizeAnswers = {
    preferredName,
    timezone,
    morningWindow,
    eveningWindow,
    categories: categories as CustomizeCategory[],
    channel: validation.channel,
    channelFallbackToInApp: validation.fallbackToInApp,
  };
  if (validation.warning) finalized.channelWarning = validation.warning;
  if (relationships)
    finalized.relationships = relationships as RelationshipAnswerEntry[];
  return finalized;
}
