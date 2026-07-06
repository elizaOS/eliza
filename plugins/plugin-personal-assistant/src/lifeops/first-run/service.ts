/**
 * `FirstRunService` — orchestrator for the first-run capability.
 *
 * Owns:
 *   - the lifecycle state machine (`pending` → `in_progress` → `complete`)
 *     via `FirstRunStateStore`
 *   - writes to the canonical `OwnerFactStore`
 *   - emission of the defaults pack into the `ScheduledTaskRunner`
 *   - the replay path (re-run without destroying tasks)
 *
 * The runner is injected: if the production runner is registered on the
 * runtime by the time the action fires, this service uses it; otherwise it
 * falls back to an in-memory recorder that is sufficient for unit /
 * integration tests.
 */

import { type IAgentRuntime, logger } from "@elizaos/core";
import { resolveDefaultTimeZone } from "../defaults.js";
import { asCacheRuntime } from "../runtime-cache.js";
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
  createSeededDefaultsStore,
  type FirstRunRecord,
  type FirstRunStateStore,
  type OwnerFactProvenance,
  type OwnerFactStore,
  type OwnerFacts,
  type OwnerFactsPatch,
  type SeededDefaultsStore,
} from "./state.js";

// --- Runner injection ------------------------------------------------------

export interface ScheduledTaskRunnerLike {
  schedule(task: ScheduledTaskInput): Promise<ScheduledTask>;
}

/**
 * Runtime-side hook used to expose the production runner. The plugin `init`
 * registers an instance via `setScheduledTaskRunner`; the first-run service
 * calls `getScheduledTaskRunner` to fetch it. When unset, the service uses
 * the in-memory fallback which is sufficient for tests.
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

// --- Flat-facts view (test-facing) ----------------------------------------

/**
 * Flat projection of the typed `OwnerFacts` store, used by callers that
 * want quick scalar access to fact values (first-run tests, replay
 * pre-fill). Provenance is intentionally elided — readers that need it go
 * through the typed `OwnerFactStore` directly.
 */
export interface FirstRunFlatFacts {
  preferredName?: string;
  timezone?: string;
  morningWindow?: { startLocal: string; endLocal: string };
  eveningWindow?: { startLocal: string; endLocal: string };
  preferredNotificationChannel?: string;
  locale?: string;
}

function flattenFacts(facts: OwnerFacts): FirstRunFlatFacts {
  const flat: FirstRunFlatFacts = {};
  if (facts.preferredName) flat.preferredName = facts.preferredName.value;
  if (facts.timezone) flat.timezone = facts.timezone.value;
  if (facts.morningWindow) {
    flat.morningWindow = {
      startLocal: facts.morningWindow.value.startLocal,
      endLocal: facts.morningWindow.value.endLocal,
    };
  }
  if (facts.eveningWindow) {
    flat.eveningWindow = {
      startLocal: facts.eveningWindow.value.startLocal,
      endLocal: facts.eveningWindow.value.endLocal,
    };
  }
  if (facts.preferredNotificationChannel) {
    flat.preferredNotificationChannel =
      facts.preferredNotificationChannel.value;
  }
  if (facts.locale) flat.locale = facts.locale.value;
  return flat;
}

function makeFirstRunProvenance(note?: string): OwnerFactProvenance {
  const provenance: OwnerFactProvenance = {
    source: "first_run",
    recordedAt: new Date().toISOString(),
  };
  if (note) provenance.note = note;
  return provenance;
}

// --- Service ---------------------------------------------------------------

export interface FirstRunRunResult {
  status: "ok" | "needs_more_input" | "already_complete";
  record: FirstRunRecord;
  facts: FirstRunFlatFacts;
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
  private readonly seededStore: SeededDefaultsStore;
  constructor(
    private readonly runtime: IAgentRuntime,
    options?: {
      stateStore?: FirstRunStateStore;
      factStore?: OwnerFactStore;
      runner?: ScheduledTaskRunnerLike;
      seededStore?: SeededDefaultsStore;
    },
  ) {
    this.stateStore = options?.stateStore ?? createFirstRunStateStore(runtime);
    this.factStore = options?.factStore ?? createOwnerFactStore(runtime);
    this.seededStore =
      options?.seededStore ?? createSeededDefaultsStore(runtime);
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

  /**
   * Schedule one default-pack input through the runner and record its
   * idempotency key in the seeded-defaults marker. The marker is the
   * deletion-respecting guard the boot seeder checks: once a key is recorded
   * here, {@link seedDefaultPackOnBoot} never re-creates it.
   */
  private async scheduleAndMark(
    runner: ScheduledTaskRunnerLike,
    input: ScheduledTaskInput,
    seededAtIso: string,
  ): Promise<ScheduledTask> {
    const task = await runner.schedule(input);
    if (input.idempotencyKey) {
      await this.seededStore.markSeeded(input.idempotencyKey, seededAtIso);
    }
    return task;
  }

  /**
   * Idempotent, boot-safe seeder for the first-run defaults pack.
   *
   * Runs on EVERY boot (not gated behind first-run completion) so existing
   * devices that predate the defaults pack still receive it. For each pack
   * item: if its idempotency key has NEVER been seeded on this device, the
   * task is created and the key is recorded; if the key was already seeded
   * once, the item is skipped — so a default the user later deleted is not
   * resurrected. The paused weekly-review starter keeps its `manual` trigger
   * and so stays paused.
   *
   * Owner facts (morning window / timezone) are used when present; otherwise
   * the standard defaults apply. Fresh installs are covered by the same
   * per-key marker, so first-run scheduling and boot seeding never double-seed.
   */
  async seedDefaultPackOnBoot(): Promise<{
    seeded: ScheduledTask[];
    skipped: string[];
  }> {
    const facts = await this.factStore.read();
    const morningWindow = facts.morningWindow?.value ?? DEFAULT_MORNING_WINDOW;
    const timezone = facts.timezone?.value ?? resolveDefaultTimeZone();
    const channel = facts.preferredNotificationChannel?.value ?? "in_app";

    const pack = buildDefaultsPack({
      morningWindow,
      timezone,
      agentId: this.runtime.agentId,
      channel,
    });

    const runner = this.resolveRunner();
    const seededAtIso = new Date().toISOString();
    const seeded: ScheduledTask[] = [];
    const skipped: string[] = [];
    for (const input of pack) {
      const key = input.idempotencyKey;
      if (key && (await this.seededStore.has(key))) {
        skipped.push(key);
        continue;
      }
      seeded.push(await this.scheduleAndMark(runner, input, seededAtIso));
    }
    if (seeded.length > 0) {
      logger.info(
        {
          src: "lifeops:first-run:boot-seeder",
          agentId: this.runtime.agentId,
          seeded: seeded.length,
          skipped: skipped.length,
        },
        `[first-run] Seeded ${seeded.length} default-pack task(s) on boot (${skipped.length} already-seeded, left untouched).`,
      );
    }
    return { seeded, skipped };
  }

  async readState(): Promise<FirstRunRecord> {
    return this.stateStore.read();
  }

  async readFacts(): Promise<FirstRunFlatFacts> {
    return flattenFacts(await this.factStore.read());
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
        facts: flattenFacts(await this.factStore.read()),
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
        facts: flattenFacts(await this.factStore.read()),
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
        facts: flattenFacts(await this.factStore.read()),
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
    const channelValidation = await validateChannel(
      input.channel ?? "in_app",
      this.runtime,
    );
    const factsPatch: OwnerFactsPatch = {
      morningWindow,
      timezone,
      eveningWindow: DEFAULT_EVENING_WINDOW,
      preferredNotificationChannel: channelValidation.channel,
    };
    const facts = await this.factStore.update(
      factsPatch,
      makeFirstRunProvenance("defaults path: wake-time answer"),
    );

    const pack = buildDefaultsPack({
      morningWindow,
      timezone,
      agentId: this.runtime.agentId,
      channel: channelValidation.channel,
    });
    const runner = this.resolveRunner();
    const seededAtIso = new Date().toISOString();
    const scheduledTasks: ScheduledTask[] = [];
    for (const input of pack) {
      scheduledTasks.push(
        await this.scheduleAndMark(runner, input, seededAtIso),
      );
    }

    const completed = await this.stateStore.complete();

    return {
      status: "ok",
      record: completed,
      facts: flattenFacts(facts),
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
        facts: flattenFacts(await this.factStore.read()),
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
        facts: flattenFacts(await this.factStore.read()),
        scheduledTasks: [],
        awaitingQuestion: next.id,
        message: next.prompt,
        warnings: [],
      };
    }

    const finalized = await finalizeCustomizeAnswers(merged, this.runtime);

    const factsPatch: OwnerFactsPatch = {
      preferredName: finalized.preferredName,
      timezone: finalized.timezone,
      morningWindow: finalized.morningWindow,
      eveningWindow: finalized.eveningWindow,
      preferredNotificationChannel: finalized.channel,
    };
    const facts = await this.factStore.update(
      factsPatch,
      makeFirstRunProvenance("customize path: completed questionnaire"),
    );

    const pack = buildDefaultsPack({
      morningWindow: finalized.morningWindow,
      timezone: finalized.timezone,
      agentId: this.runtime.agentId,
      channel: finalized.channel,
    });
    const runner = this.resolveRunner();
    const seededAtIso = new Date().toISOString();
    const scheduledTasks: ScheduledTask[] = [];
    for (const input of pack) {
      scheduledTasks.push(
        await this.scheduleAndMark(runner, input, seededAtIso),
      );
    }
    // Categories that gate followups would create per-relationship watcher
    // tasks via the followup-starter pack. Here we just record the
    // selection on the answers; the pack reads those facts at boot.

    const completed = await this.stateStore.complete();
    const warnings: string[] = [];
    if (finalized.channelWarning) {
      warnings.push(finalized.channelWarning);
    }
    return {
      status: "ok",
      record: completed,
      facts: flattenFacts(facts),
      scheduledTasks,
      message: this.formatCustomizeCompleteMessage(
        finalized,
        scheduledTasks.length,
      ),
      warnings,
    };
  }

  /**
   * Replay. Keeps existing tasks intact (the runner upserts by
   * `idempotencyKey`); only OwnerFactStore facts the questions touch are
   * updated.
   */
  async runReplayPath(input: ReplayPathInput): Promise<FirstRunRunResult> {
    let record = await this.stateStore.read();
    if (record.status !== "in_progress" || record.path !== "replay") {
      record = await this.stateStore.begin("replay");
    }
    const currentTypedFacts = await this.factStore.read();
    const partial = partialAnswersFromFacts(currentTypedFacts);
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
        facts: flattenFacts(currentTypedFacts),
        scheduledTasks: [],
        awaitingQuestion: next.id,
        message: next.prompt,
        warnings: [],
      };
    }

    const finalized = await finalizeCustomizeAnswers(merged, this.runtime);
    const factsPatch: OwnerFactsPatch = {
      preferredName: finalized.preferredName,
      timezone: finalized.timezone,
      morningWindow: finalized.morningWindow,
      eveningWindow: finalized.eveningWindow,
      preferredNotificationChannel: finalized.channel,
    };
    const facts = await this.factStore.update(
      factsPatch,
      makeFirstRunProvenance("replay path: refreshed answers"),
    );

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
    const seededAtIso = new Date().toISOString();
    const scheduledTasks: ScheduledTask[] = [];
    for (const taskInput of pack) {
      scheduledTasks.push(
        await this.scheduleAndMark(runner, taskInput, seededAtIso),
      );
    }

    const completed = await this.stateStore.complete();
    const warnings: string[] = [];
    if (finalized.channelWarning) warnings.push(finalized.channelWarning);
    return {
      status: "ok",
      record: completed,
      facts: flattenFacts(facts),
      scheduledTasks,
      message: "Settings refreshed. Existing scheduled tasks were preserved.",
      warnings,
    };
  }

  /** Clears lifecycle state without rerunning first-run. */
  async resetState(): Promise<void> {
    await this.stateStore.reset();
    await this.seededStore.reset();
  }

  private resolveTimezone(): string {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    } catch {
      return "UTC";
    }
  }

  private formatDefaultsCompleteMessage(taskCount: number): string {
    return `Defaults applied — ${taskCount} routines set up (gm, gn, daily check-in, morning brief, encrypted local backups, plus a paused weekly review you can turn on anytime).`;
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

async function finalizeCustomizeAnswers(
  answers: Record<string, unknown>,
  runtime: IAgentRuntime,
): Promise<FinalizedCustomizeAnswers> {
  const preferredName = parsePreferredName(answers.preferredName) ?? "";
  const timezone = parseTimezone(answers.timezone) ?? "UTC";
  const morningWindow =
    parseTimeWindow(answers.morningWindow) ?? DEFAULT_MORNING_WINDOW;
  const eveningWindow =
    parseTimeWindow(answers.eveningWindow) ?? DEFAULT_EVENING_WINDOW;
  const categories = parseCategories(answers.categories) ?? [];
  const validation = await validateChannel(answers.channel, runtime);
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
