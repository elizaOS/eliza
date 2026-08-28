/**
 * Injected-disconnection twin of the sleep-cycle check-in observability
 * scenario (#29068): proves the EXPLICIT non-persistence and typed failure
 * contract when no delivery surface is reachable.
 *
 * Where its sibling scenario proves delivery + persistence + dedupe against
 * the registered production agent-event service, this scenario uses the
 * scenario-harness's sanctioned injection seam: `getAgentEventService`
 * duck-types `runtime.getService("agent_event")`, so a seed step wraps that
 * one method to return null for the agent-event aliases ONLY — the exact
 * observable state production hits when the event stream host is absent
 * (the state the issue was filed against). Everything downstream is the
 * REAL production path: `processSleepCycleCheckins` →
 * `dispatchCheckinReport` → `emitAssistantEvent` → typed `disconnected`.
 *
 * Assertions:
 *   - the tick summary reports the morning check-in as `disconnected` with
 *     the report id and reason (typed failure, not a vanishing log line);
 *   - the `sleep_cycle_checkins` subsystem failure is present in
 *     `subsystemFailures` — an unplanned `disconnected` result FAILS the
 *     owning scenario instead of hiding in a green batch (#29068 AC 6);
 *   - no `life_checkin_reports` row exists for the generated report id —
 *     non-persistence is explicit and read back authoritatively.
 *
 * Runs keylessly; the model fallback path renders the summary.
 */
import type { ScenarioContext } from "@elizaos/scenario-runner/schema";
import { scenario } from "@elizaos/scenario-runner/schema";

const SCENARIO_ID = "deterministic-sleep-checkin-disconnected";
const AGENT_EVENT_ALIASES = new Set(["agent_event", "AGENT_EVENT"]);

const MINUTE_MS = 60_000;
const BASE = new Date(Math.floor(Date.now() / 1000) * 1000);
const WAKE_AT = new Date(BASE.getTime() - 30 * MINUTE_MS);
// The tick lands inside the seeded cloud state's 45-minute freshness window
// (and inside the 6h morning-checkin window) so the effective schedule is the
// seeded observation merge, deterministically.
const TICK_1 = new Date(BASE.getTime() + 5 * MINUTE_MS);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

interface RuntimeLike {
  agentId: string;
  getService?: (serviceType: string) => unknown;
}

let originalGetService: ((serviceType: string) => unknown) | null = null;
let disconnectedReportId: string | null = null;

function injectAgentEventDisconnection(
  ctx: ScenarioContext,
): string | undefined {
  const runtime = ctx.runtime as
    | (RuntimeLike & { getService?: (serviceType: string) => unknown })
    | undefined;
  if (typeof runtime?.getService !== "function") {
    return "scenario runtime does not expose getService; cannot inject the disconnection";
  }
  originalGetService = runtime.getService.bind(runtime);
  // Injection seam (harness-only): the production resolver
  // `getAgentEventService` probes these aliases via `runtime.getService`;
  // answering null reproduces the "Assistant event stream is not
  // registered" state the issue observed in run 61c0bea8. All other
  // services pass through untouched.
  runtime.getService = (serviceType: string): unknown =>
    AGENT_EVENT_ALIASES.has(serviceType)
      ? null
      : (originalGetService as (serviceType: string) => unknown)(serviceType);
  return undefined;
}

function restoreAgentEventResolution(): string | undefined {
  const ctx = currentRuntime as
    | (RuntimeLike & {
        getService?: (serviceType: string) => unknown;
      })
    | null;
  if (ctx && originalGetService) {
    ctx.getService = originalGetService;
  }
  originalGetService = null;
  return undefined;
}

let currentRuntime:
  | (RuntimeLike & { getService?: (serviceType: string) => unknown })
  | null = null;

function captureRuntime(ctx: ScenarioContext): string | undefined {
  currentRuntime = ctx.runtime as typeof currentRuntime;
  return undefined;
}

function assertDisconnectedTick(
  _status: number,
  body: unknown,
): string | undefined {
  if (!isRecord(body) || body.success !== true) {
    return `expected tick success=true, saw ${JSON.stringify(body)}`;
  }
  const raw = body.sleepCycleCheckins;
  if (!Array.isArray(raw)) {
    return `expected sleepCycleCheckins array, saw ${JSON.stringify(raw)}`;
  }
  const checkin = raw.find(
    (entry) => isRecord(entry) && entry.kind === "morning",
  );
  if (!isRecord(checkin)) {
    return (
      `expected a morning check-in result on the disconnected tick, saw ${JSON.stringify(raw)}; ` +
      "the seeded wake observation should make it due"
    );
  }
  if (checkin.status !== "disconnected") {
    return `expected typed status=disconnected, saw ${JSON.stringify(checkin.status)}`;
  }
  if (typeof checkin.reportId !== "string" || checkin.reportId.length === 0) {
    return (
      "the disconnected result must carry the generated report id so the " +
      `failure is attributable, saw ${JSON.stringify(checkin.reportId)}`
    );
  }
  if (typeof checkin.reason !== "string" || checkin.reason !== "disconnected") {
    return `expected reason=disconnected, saw ${JSON.stringify(checkin.reason)}`;
  }
  if (checkin.persisted !== false) {
    return `non-persistence must be explicit (persisted=false), saw ${JSON.stringify(checkin.persisted)}`;
  }
  disconnectedReportId = checkin.reportId;
  const failures = Array.isArray(body.subsystemFailures)
    ? body.subsystemFailures.filter(isRecord)
    : [];
  const sleepFailure = failures.find(
    (failure) => failure.subsystem === "sleep_cycle_checkins",
  );
  if (!sleepFailure) {
    return (
      "an unplanned disconnected check-in must surface as a " +
      "sleep_cycle_checkins subsystem failure — not a warning in a green " +
      `batch (#29068); saw ${JSON.stringify(failures)}`
    );
  }
  if (!String(sleepFailure.error ?? "").includes("not persisted")) {
    return (
      "the subsystem failure must state non-persistence, saw " +
      JSON.stringify(sleepFailure.error)
    );
  }
  return undefined;
}

async function assertNoPersistedReport(
  ctx: ScenarioContext,
): Promise<string | undefined> {
  if (!disconnectedReportId) {
    return "disconnected tick did not capture a report id";
  }
  const { executeRawSql } = await import(
    "@elizaos/plugin-personal-assistant/lifeops/sql"
  );
  const rows = await executeRawSql(
    ctx.runtime as Parameters<typeof executeRawSql>[0],
    "SELECT id FROM app_lifeops.life_checkin_reports",
  );
  const match = rows.find((row) => row?.id === disconnectedReportId);
  if (match) {
    return (
      `report ${disconnectedReportId} was persisted despite delivery rejection; ` +
      "persistence must happen only after delivery acceptance"
    );
  }
  return undefined;
}

export default scenario({
  // The scenario catalog reads metadata statically (loader.ts getStaticStringProperty),
  // so `id` must be a string literal, not the SCENARIO_ID constant.
  id: "deterministic-sleep-checkin-disconnected",
  lane: "pr-deterministic",
  modelFixtures: {
    mode: "fixtures",
    fixtures: [
      {
        // The rejected report's summary still renders before delivery is
        // attempted (CheckinService.renderSummary, TEXT_LARGE). Empty text
        // keeps the deterministic collector-summary fallback — keyless.
        name: "checkin-summary-morning",
        match: {
          modelType: ["TEXT_LARGE", "TEXT_SMALL"],
          input: { pattern: "morning personal-assistant intro summary" },
        },
        cardinality: "any",
        response: { text: "" },
      },
    ],
  },
  title:
    "A sleep-cycle check-in whose assistant stream is unreachable fails the tick typed and is not persisted",
  domain: "lifeops",
  tags: [
    "pr",
    "deterministic",
    "zero-cost",
    "lifeops",
    "sleep-cycle",
    "checkin",
    "fault-injection",
  ],
  isolation: "shared-runtime",
  requires: {
    plugins: [
      "@elizaos/plugin-scheduling",
      "@elizaos/plugin-personal-assistant",
    ],
  },
  seed: [
    { type: "custom", name: "capture the runtime", apply: captureRuntime },
    {
      type: "custom",
      name: "inject agent-event disconnection for this scenario only",
      apply: injectAgentEventDisconnection,
    },
  ],
  cleanup: [
    {
      type: "custom",
      name: "restore production service resolution",
      apply: restoreAgentEventResolution,
    },
  ],
  turns: [
    {
      kind: "api",
      name: "seed a wake observation through the real schedule-observations surface",
      method: "POST",
      path: "/api/lifeops/schedule/observations",
      body: {
        deviceId: `${SCENARIO_ID}-watch`,
        deviceKind: "watch",
        timezone: "UTC",
        observedAt: WAKE_AT.toISOString(),
        observations: [
          {
            circadianState: "awake",
            stateConfidence: 0.95,
            windowStartAt: WAKE_AT.toISOString(),
            snapshot: {
              wakeAt: WAKE_AT.toISOString(),
              lastSleepEndedAt: WAKE_AT.toISOString(),
              sleepStatus: "slept",
              sleepConfidence: 0.9,
              lastActiveAt: WAKE_AT.toISOString(),
            },
          },
        ],
      },
      expectedStatus: 200,
    },
    {
      kind: "tick",
      name: "tick at dueness — delivery rejects typed, nothing persists, the tick fails",
      worker: "lifeops_scheduler",
      options: { now: TICK_1.toISOString(), scheduledTaskLimit: 50 },
      assertResponse: assertDisconnectedTick,
    },
  ],
  finalChecks: [
    {
      type: "custom",
      name: "no report row persisted for the rejected delivery",
      predicate: async (ctx: ScenarioContext) =>
        await assertNoPersistedReport(ctx),
    },
  ],
});
