/**
 * Deterministic seeded ignore-pattern -> recalibrate journey for the BRIEF
 * engagement feedback loop (#14872). Runs the REAL `BRIEF` action handler,
 * `LifeOpsRepository`, and PGLite-backed engagement ledger under strict
 * Stage-1 + planner fixtures on the pr-deterministic lane.
 *
 * The seed reproduces five scenario-days of owner behavior through the
 * production write paths: a newsletter-digest inbox item is rendered on each
 * of five briefs, the owner acts on none of them, and the real
 * `finalizeExpiredBriefItemEngagements` reconciliation closes the four
 * expired delivery windows as `ignored` (day five's window is still open, so
 * inferred auto-demotion has not yet triggered). A contrasting
 * high-consequence calendar item is rendered once and completed inside its
 * window, proving acted-on classes are never punished.
 *
 * The turns then exercise the owner-facing loop end to end:
 *   1. "You keep briefing me on things I never act on. Recalibrate." —
 *      the BRIEF `recalibrate` verb summarizes the ledger (surfaced 9,
 *      acted on 0), demotes exactly `inbox:newsletter-digest` via an
 *      explicit reversible `demoted` marker, and leaves the acted-on
 *      calendar class untouched.
 *   2. The next composed morning brief's editorial contract carries the
 *      demotion, so persisted history changes the next brief.
 *   3. `reset_recalibration` restores the class with a `restored` marker.
 *   4. A second composed brief proves the restoration: no demoted classes.
 *
 * The final check reads the raw ledger rows back through the repository and
 * asserts the full row-level evidence the issue's acceptance bar names:
 * ignored rows, the demoted marker, the restored marker, and the untouched
 * acted-on class.
 */

import { ModelType } from "@elizaos/core";
import {
  type RuntimeWithScenarioModelFixtures,
  registerStrictActionRouteFixtures,
  type StrictActionRouteFixture,
} from "@elizaos/core/testing";
import type {
  CapturedAction,
  ScenarioContext,
  ScenarioTurnExecution,
} from "@elizaos/scenario-runner/schema";
import { scenario } from "@elizaos/scenario-runner/schema";

type JsonRecord = Record<string, unknown>;

const SCENARIO_ID = "deterministic-lifeops-brief-recalibrate";
const NEWSLETTER_CLASS = "inbox:newsletter-digest";
const CALENDAR_CLASS = "calendar:high-consequence";

// ---------------------------------------------------------------------------
// Structural views of the plugin-personal-assistant repository surface. The
// module is loaded dynamically inside the seed so this file, like the sibling
// lifeops scenarios, never imports the plugin's TypeScript sources directly.
// ---------------------------------------------------------------------------

interface EngagementRowLike {
  itemClass: string;
  eventType: string;
  eventAt: string;
}

interface LifeOpsRepositoryLike {
  recordBriefItemEngagement(input: {
    agentId: string;
    briefingId: string;
    itemId: string;
    source: string;
    kind: string;
    sourceId: string;
    itemClass: string;
    eventType: string;
    eventAt: string;
    weight: number;
    metadata: JsonRecord;
  }): Promise<unknown>;
  listBriefItemEngagements(
    agentId: string,
    options?: { itemClass?: string },
  ): Promise<readonly EngagementRowLike[]>;
  finalizeExpiredBriefItemEngagements(
    agentId: string,
    options?: { asOfIso?: string; windowHours?: number },
  ): Promise<number>;
}

interface RuntimeLike {
  agentId: string;
}

async function openRepository(
  runtime: unknown,
): Promise<LifeOpsRepositoryLike> {
  const repositoryModule = (await import(
    "@elizaos/plugin-personal-assistant/lifeops/repository"
  )) as {
    LifeOpsRepository: new (runtime: unknown) => LifeOpsRepositoryLike;
  };
  return new repositoryModule.LifeOpsRepository(runtime);
}

async function clearEngagementLedger(runtime: unknown): Promise<void> {
  const sqlModule = (await import(
    "@elizaos/plugin-personal-assistant/lifeops/sql"
  )) as {
    executeRawSql: (runtime: unknown, sql: string) => Promise<unknown[]>;
  };
  const agentId = (runtime as RuntimeLike).agentId;
  await sqlModule.executeRawSql(
    runtime,
    `DELETE FROM app_lifeops.life_brief_item_engagements WHERE agent_id = '${agentId}'`,
  );
}

// ---------------------------------------------------------------------------
// Simulated five-day owner history, anchored to the wall clock at load. Days
// one through four rendered more than 24 hours ago (their delivery windows
// are expired); day five rendered one hour ago (window still open).
// ---------------------------------------------------------------------------

const DAY_MS = 24 * 60 * 60_000;
const HOUR_MS = 60 * 60_000;
const SEED_NOW = Date.now();

function seedDayIso(daysAgo: number): string {
  return new Date(SEED_NOW - daysAgo * DAY_MS).toISOString();
}

// ---------------------------------------------------------------------------
// Strict message-loop fixtures: one Stage-1 + planner pair per message turn,
// plus the deterministic TEXT_LARGE narrative for the two compose passes.
// ---------------------------------------------------------------------------

const recalibrateText =
  "You keep briefing me on things I never act on. Recalibrate.";
const composeText = "Give me my morning brief";
const resetText = "Reset the brief recalibration for the newsletter digests";
const composeAgainText = "Run my morning brief again";

// Route straight to the promoted `<BRIEF>_<SUBACTION>` virtual actions
// (`promoteSubactionsToActions` in core): picking the plain BRIEF umbrella
// tool triggers a second subaction-narrowing planner pass, which a strict
// one-fixture-per-turn scenario deliberately does not model.
const strictRoutes: StrictActionRouteFixture[] = [
  {
    actionName: "BRIEF_RECALIBRATE",
    input: recalibrateText,
    args: {},
  },
  {
    actionName: "BRIEF_COMPOSE_MORNING",
    input: composeText,
    args: {},
  },
  {
    actionName: "BRIEF_RESET_RECALIBRATION",
    input: resetText,
    args: { itemClass: NEWSLETTER_CLASS },
  },
  {
    actionName: "BRIEF_COMPOSE_MORNING",
    input: composeAgainText,
    args: {},
  },
];

async function seedIgnorePattern(
  ctx: ScenarioContext,
): Promise<string | undefined> {
  const runtime = ctx.runtime;
  if (!runtime) return "scenario runtime is unavailable";
  const agentId = (runtime as RuntimeLike).agentId;

  // The shared-runtime store may hold ledger rows from earlier runs; the
  // journey's counts are exact, so start from a clean per-agent ledger.
  await clearEngagementLedger(runtime);

  const repository = await openRepository(runtime);

  // Five scenario-days of rendered newsletter-digest impressions the owner
  // never acted on. Day offsets 5..2 are older than the 24h delivery window;
  // day offset 0 (one hour ago) is still open.
  const renderedOffsets = [5, 4, 3, 2];
  for (const [index, daysAgo] of renderedOffsets.entries()) {
    await repository.recordBriefItemEngagement({
      agentId,
      briefingId: `${SCENARIO_ID}-day-${index + 1}`,
      itemId: `inbox:seed-newsletter-${index + 1}`,
      source: "inbox",
      kind: "message",
      sourceId: `seed-newsletter-${index + 1}`,
      itemClass: NEWSLETTER_CLASS,
      eventType: "rendered",
      eventAt: seedDayIso(daysAgo),
      weight: 0,
      metadata: { scenario: SCENARIO_ID, seedDay: index + 1 },
    });
  }
  await repository.recordBriefItemEngagement({
    agentId,
    briefingId: `${SCENARIO_ID}-day-5`,
    itemId: "inbox:seed-newsletter-5",
    source: "inbox",
    kind: "message",
    sourceId: "seed-newsletter-5",
    itemClass: NEWSLETTER_CLASS,
    eventType: "rendered",
    eventAt: new Date(SEED_NOW - HOUR_MS).toISOString(),
    weight: 0,
    metadata: { scenario: SCENARIO_ID, seedDay: 5 },
  });

  // Contrast class: a high-consequence calendar item the owner completed
  // inside its delivery window. Reconciliation must never mark it ignored and
  // recalibration must never demote it.
  await repository.recordBriefItemEngagement({
    agentId,
    briefingId: `${SCENARIO_ID}-day-1`,
    itemId: "calendar:seed-board-prep",
    source: "calendar",
    kind: "meeting",
    sourceId: "seed-board-prep",
    itemClass: CALENDAR_CLASS,
    eventType: "rendered",
    eventAt: seedDayIso(5),
    weight: 0,
    metadata: { scenario: SCENARIO_ID, seedDay: 1 },
  });
  await repository.recordBriefItemEngagement({
    agentId,
    briefingId: `${SCENARIO_ID}-day-1`,
    itemId: "calendar:seed-board-prep",
    source: "calendar",
    kind: "meeting",
    sourceId: "seed-board-prep",
    itemClass: CALENDAR_CLASS,
    eventType: "completed",
    eventAt: new Date(SEED_NOW - 5 * DAY_MS + HOUR_MS).toISOString(),
    weight: 1,
    metadata: { scenario: SCENARIO_ID, seedDay: 1, domainEventId: "seed-1" },
  });

  // Real reconciliation: exactly the four expired newsletter windows close as
  // ignored. The acted-on calendar window and the still-open day-5 window
  // must survive untouched.
  const finalized = await repository.finalizeExpiredBriefItemEngagements(
    agentId,
    { asOfIso: new Date(SEED_NOW).toISOString() },
  );
  if (finalized !== 4) {
    return `expected finalizeExpiredBriefItemEngagements to close exactly 4 windows, closed ${finalized}`;
  }

  const fixturesRuntime = runtime as RuntimeWithScenarioModelFixtures;
  registerStrictActionRouteFixtures(fixturesRuntime, strictRoutes);
  fixturesRuntime.scenarioModelFixtures?.register({
    name: `${SCENARIO_ID}-morning-narrative`,
    match: {
      modelType: ModelType.TEXT_LARGE,
      prompt: (prompt: string) =>
        prompt.startsWith("You are composing the owner's morning briefing"),
    },
    response:
      "Quiet morning. Nothing high-consequence is on deck; newsletter digests stay demoted until you restore them.",
    times: { min: 0, max: 2 },
  });
  return undefined;
}

// ---------------------------------------------------------------------------
// Assertion helpers
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function briefCall(execution: ScenarioTurnExecution): CapturedAction | string {
  const action = execution.actionsCalled.find(
    (candidate) =>
      candidate.actionName === "BRIEF" ||
      candidate.actionName.startsWith("BRIEF_"),
  );
  return (
    action ??
    `expected a BRIEF action call, saw ${
      execution.actionsCalled
        .map((candidate) => candidate.actionName)
        .join(", ") || "none"
    }`
  );
}

function briefData(execution: ScenarioTurnExecution): JsonRecord | string {
  const call = briefCall(execution);
  if (typeof call === "string") return call;
  if (call.result?.success !== true) {
    return `expected BRIEF success, saw ${JSON.stringify(call.result)}`;
  }
  return isRecord(call.result.data)
    ? call.result.data
    : `expected structured BRIEF result data, saw ${JSON.stringify(call.result.data)}`;
}

function stringArray(value: unknown): readonly string[] | null {
  return Array.isArray(value) &&
    value.every((entry) => typeof entry === "string")
    ? (value as string[])
    : null;
}

function editorialContract(data: JsonRecord): JsonRecord | string {
  const briefing = data.briefing;
  if (!isRecord(briefing)) {
    return `expected BRIEF data.briefing, saw ${JSON.stringify(data)}`;
  }
  const editorial = briefing.editorial;
  return isRecord(editorial)
    ? editorial
    : `expected briefing.editorial contract, saw ${JSON.stringify(briefing)}`;
}

function expectRecalibrateTurn(
  execution: ScenarioTurnExecution,
): string | undefined {
  const data = briefData(execution);
  if (typeof data === "string") return data;
  if (data.subaction !== "recalibrate") {
    return `expected recalibrate subaction, saw ${JSON.stringify(data.subaction)}`;
  }
  const demoted = stringArray(data.demotedItemClasses);
  if (!demoted || demoted.length !== 1 || demoted[0] !== NEWSLETTER_CLASS) {
    return `expected exactly [${NEWSLETTER_CLASS}] demoted, saw ${JSON.stringify(data.demotedItemClasses)}`;
  }
  const already = stringArray(data.alreadyDemotedItemClasses);
  if (!already || already.length !== 0) {
    return `expected no previously demoted classes, saw ${JSON.stringify(data.alreadyDemotedItemClasses)}`;
  }
  const text = execution.responseText ?? "";
  if (!text.includes("surfaced 9 times, acted on 0")) {
    return `expected the ledger summary "surfaced 9 times, acted on 0" in the reply, saw ${JSON.stringify(text)}`;
  }
  return undefined;
}

function expectComposeTurn(
  execution: ScenarioTurnExecution,
  expectedDemoted: readonly string[],
): string | undefined {
  const data = briefData(execution);
  if (typeof data === "string") return data;
  if (data.subaction !== "compose_morning") {
    return `expected compose_morning subaction, saw ${JSON.stringify(data.subaction)}`;
  }
  const editorial = editorialContract(data);
  if (typeof editorial === "string") return editorial;
  const demoted = stringArray(editorial.demotedItemClasses);
  if (
    !demoted ||
    demoted.length !== expectedDemoted.length ||
    expectedDemoted.some((entry, index) => demoted[index] !== entry)
  ) {
    return `expected editorial demotedItemClasses ${JSON.stringify(expectedDemoted)}, saw ${JSON.stringify(editorial.demotedItemClasses)}`;
  }
  return undefined;
}

function expectResetTurn(execution: ScenarioTurnExecution): string | undefined {
  const data = briefData(execution);
  if (typeof data === "string") return data;
  if (data.subaction !== "reset_recalibration") {
    return `expected reset_recalibration subaction, saw ${JSON.stringify(data.subaction)}`;
  }
  const restored = stringArray(data.restoredItemClasses);
  if (!restored || restored.length !== 1 || restored[0] !== NEWSLETTER_CLASS) {
    return `expected exactly [${NEWSLETTER_CLASS}] restored, saw ${JSON.stringify(data.restoredItemClasses)}`;
  }
  return undefined;
}

function countEvents(
  rows: readonly EngagementRowLike[],
  eventType: string,
): number {
  return rows.filter((row) => row.eventType === eventType).length;
}

async function expectLedgerEvidence(
  ctx: ScenarioContext,
): Promise<string | undefined> {
  const runtime = ctx.runtime;
  if (!runtime) return "scenario runtime is unavailable";
  const agentId = (runtime as RuntimeLike).agentId;
  const repository = await openRepository(runtime);

  const newsletter = await repository.listBriefItemEngagements(agentId, {
    itemClass: NEWSLETTER_CLASS,
  });
  const newsletterCounts = {
    rendered: countEvents(newsletter, "rendered"),
    ignored: countEvents(newsletter, "ignored"),
    demoted: countEvents(newsletter, "demoted"),
    restored: countEvents(newsletter, "restored"),
  };
  if (
    newsletterCounts.rendered !== 5 ||
    newsletterCounts.ignored !== 4 ||
    newsletterCounts.demoted !== 1 ||
    newsletterCounts.restored !== 1
  ) {
    return `expected newsletter ledger rendered=5 ignored=4 demoted=1 restored=1, saw ${JSON.stringify(newsletterCounts)}`;
  }

  const calendar = await repository.listBriefItemEngagements(agentId, {
    itemClass: CALENDAR_CLASS,
  });
  const calendarCounts = {
    rendered: countEvents(calendar, "rendered"),
    completed: countEvents(calendar, "completed"),
    ignored: countEvents(calendar, "ignored"),
    demoted: countEvents(calendar, "demoted"),
  };
  if (
    calendarCounts.rendered !== 1 ||
    calendarCounts.completed !== 1 ||
    calendarCounts.ignored !== 0 ||
    calendarCounts.demoted !== 0
  ) {
    return `expected acted-on calendar ledger rendered=1 completed=1 ignored=0 demoted=0, saw ${JSON.stringify(calendarCounts)}`;
  }
  return undefined;
}

export default scenario({
  id: "deterministic-lifeops-brief-recalibrate",
  lane: "pr-deterministic",
  title: "Deterministic BRIEF seeded ignore-pattern recalibration journey",
  domain: "lifeops",
  tags: ["pr", "deterministic", "zero-cost", "lifeops", "brief"],
  isolation: "shared-runtime",
  requires: {
    plugins: [
      "@elizaos/plugin-scheduling",
      "@elizaos/plugin-personal-assistant",
    ],
  },
  seed: [
    {
      type: "custom",
      name: "seed five-day ignore pattern + strict BRIEF fixtures",
      apply: seedIgnorePattern,
    },
  ],
  rooms: [
    {
      id: "main",
      source: "telegram",
      title: "Deterministic LifeOps Brief Recalibration",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "owner asks to recalibrate the ignored-item pattern",
      text: recalibrateText,
      // BRIEF commits are turnComplete + verifiedUserFacing: the action's
      // ledger summary is the turn's reply, not the planner fixture text.
      responseIncludesAny: ["Recalibrated your brief"],
      responseIncludesAll: [NEWSLETTER_CLASS, "reversible"],
      assertTurn: expectRecalibrateTurn,
    },
    {
      kind: "message",
      name: "next morning brief carries the demotion",
      text: composeText,
      assertTurn: (execution) =>
        expectComposeTurn(execution, [NEWSLETTER_CLASS]),
    },
    {
      kind: "message",
      name: "owner reverses the recalibration",
      text: resetText,
      responseIncludesAny: [`Restored ${NEWSLETTER_CLASS}`],
      assertTurn: expectResetTurn,
    },
    {
      kind: "message",
      name: "the brief after the reset no longer demotes the class",
      text: composeAgainText,
      assertTurn: (execution) => expectComposeTurn(execution, []),
    },
  ],
  finalChecks: [
    {
      type: "actionCalled",
      actionName: "BRIEF_RECALIBRATE",
      status: "success",
      minCount: 1,
    },
    {
      type: "actionCalled",
      actionName: "BRIEF_COMPOSE_MORNING",
      status: "success",
      minCount: 2,
    },
    {
      type: "actionCalled",
      actionName: "BRIEF_RESET_RECALIBRATION",
      status: "success",
      minCount: 1,
    },
    {
      type: "selectedActionArguments",
      actionName: "BRIEF_RESET_RECALIBRATION",
      includesAll: [/"itemClass":"inbox:newsletter-digest"/],
    },
    {
      type: "custom",
      name: "engagement ledger rows match the seeded journey",
      predicate: expectLedgerEvidence,
    },
  ],
});
