/**
 * Observable sleep-cycle check-in delivery (#29068).
 *
 * The scenario runtime previously booted WITHOUT the agent-event service, so
 * a due morning sleep-cycle check-in dispatched `in_app` → `disconnected`,
 * the generated report was not persisted, and the batch still passed because
 * assertions only covered other work. This scenario pins the fixed contract:
 *
 *   seed  — a device wake observation lands through the REAL REST surface
 *           (`POST /api/lifeops/schedule/observations`), the same boundary a
 *           device peer uses. The merged schedule then says `awake` with a
 *           fresh `wakeAt`, which makes the morning check-in DUE.
 *   tick  — the REAL scheduler entry (`executeLifeOpsSchedulerTask` via the
 *           executor's tick turn) runs the whole `processScheduledWork`
 *           chain. The production agent-event service (registered by the
 *           scenario runtime factory) accepts the in-app delivery, the event
 *           ledger captures exactly one `assistant`-stream event carrying the
 *           report identity, and the report row is persisted.
 *   tick 2 — a duplicate tick at the same local day cannot re-deliver or
 *           re-persist: the day-dedupe reports `skipped_already_sent`.
 *   read  — the authoritative `life_checkin_reports` table read back through
 *           the runtime DB shows exactly one `morning` row whose id equals
 *           the delivered report id.
 *
 * The event ledger subscribes through the SAME `AgentEventService.subscribe`
 * seam the API server uses — production-contract observation, not a spy on
 * plugin internals.
 *
 * Runs keylessly: no LLM turns (the check-in summary falls back to the
 * deterministic collector summary), no wall-clock sleeps, no live connector.
 *
 * Fail-without-fix anchor: revert the factory registration of
 * `AgentEventService` (or the `sleepCycleCheckins` observability in
 * `processScheduledWork`) and tick 1 returns a `disconnected` result — the
 * tick-1 assertion and both final checks fail.
 */
import type { ScenarioContext } from "@elizaos/scenario-runner/schema";
import { scenario } from "@elizaos/scenario-runner/schema";

const SCENARIO_ID = "deterministic-sleep-checkin-observability";

// ---------------------------------------------------------------------------
// Synthetic timeline. All instants derive from one base so the seeded wake
// observation is recent relative to the tick `now`: the tick MUST land inside
// the seeded cloud state's 45-minute freshness window (SCHEDULE_CLOUD_STATE_
// FRESH_MS) so the effective schedule is the seeded observation merge, not an
// ambient local inference; the morning check-in window is 6h after wakeAt;
// the observation TTL for `awake` is 4h.
// ---------------------------------------------------------------------------
const MINUTE_MS = 60_000;
const BASE = new Date(Math.floor(Date.now() / 1000) * 1000);
const WAKE_AT = new Date(BASE.getTime() - 30 * MINUTE_MS);
const TICK_1 = new Date(BASE.getTime() + 5 * MINUTE_MS);
const TICK_2 = new Date(BASE.getTime() + 6 * MINUTE_MS);

// ---------------------------------------------------------------------------
// Assistant event ledger — subscribes through the production
// AgentEventService seam exactly like the API server does.
// ---------------------------------------------------------------------------
interface CapturedAssistantEvent {
  runId: string;
  stream: string;
  agentId?: string;
  text: string;
  source: string;
  reportId: unknown;
  checkinKind: unknown;
  deliveryBasis: unknown;
  ts: number;
  seq: number;
}

interface AgentEventServiceLike {
  subscribe: (listener: (event: CapturedAssistantEvent) => void) => () => void;
}

interface RuntimeLike {
  agentId: string;
  getService?: (serviceType: string) => unknown;
}

let unsubscribeLedger: (() => void) | null = null;
const eventLedger: CapturedAssistantEvent[] = [];

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function seedAssistantEventLedger(ctx: ScenarioContext): string | undefined {
  eventLedger.length = 0;
  unsubscribeLedger?.();
  unsubscribeLedger = null;
  const runtime = ctx.runtime as RuntimeLike | undefined;
  const service = runtime?.getService?.("agent_event") as
    | AgentEventServiceLike
    | null
    | undefined;
  if (!service || typeof service.subscribe !== "function") {
    return (
      "production agent_event service is not registered on the scenario " +
      "runtime before LifeOps background work begins (#29068 AC 1)"
    );
  }
  unsubscribeLedger = service.subscribe((event) => {
    if (event?.stream !== "assistant") return;
    const data = isRecord(event.data) ? event.data : {};
    eventLedger.push({
      runId: event.runId,
      stream: event.stream,
      agentId: event.agentId,
      text: String(data.text ?? ""),
      source: String(data.source ?? ""),
      reportId: data.reportId,
      checkinKind: data.checkinKind,
      deliveryBasis: data.deliveryBasis,
      ts: event.ts,
      seq: event.seq,
    });
  });
  return undefined;
}

// ---------------------------------------------------------------------------
// Response readers
// ---------------------------------------------------------------------------
interface CheckinResultEntry {
  kind: string;
  status: string;
  reportId: string | null;
  messageId: string | null;
  reason: string | null;
  persisted: boolean;
}

function readSleepCycleCheckins(body: unknown): CheckinResultEntry[] | string {
  if (!isRecord(body) || body.success !== true) {
    return `expected tick success=true, saw ${JSON.stringify(body)}`;
  }
  const raw = body.sleepCycleCheckins;
  if (!Array.isArray(raw)) {
    return (
      "expected sleepCycleCheckins array in the tick summary " +
      `(#29068 observability), saw ${JSON.stringify(raw)}`
    );
  }
  const entries: CheckinResultEntry[] = [];
  for (const entry of raw) {
    if (
      !isRecord(entry) ||
      typeof entry.kind !== "string" ||
      typeof entry.status !== "string"
    ) {
      return `malformed sleepCycleCheckins entry: ${JSON.stringify(entry)}`;
    }
    entries.push({
      kind: entry.kind,
      status: entry.status,
      reportId: typeof entry.reportId === "string" ? entry.reportId : null,
      messageId: typeof entry.messageId === "string" ? entry.messageId : null,
      reason: typeof entry.reason === "string" ? entry.reason : null,
      persisted: entry.persisted === true,
    });
  }
  return entries;
}

function readSubsystemFailures(body: unknown): string[] {
  if (!isRecord(body) || !Array.isArray(body.subsystemFailures)) return [];
  return body.subsystemFailures
    .filter(isRecord)
    .map((failure) => String(failure.subsystem ?? "?"));
}

let deliveredReportId: string | null = null;

function bucketedIso(value: string): string {
  // Schedule observations bucket instants to 30-minute boundaries
  // (SCHEDULE_OBSERVATION_BUCKET_MINUTES, mode "nearest") before merging, so
  // the merged wakeAt is the seeded instant rounded to the nearest
  // half-hour — assert on the bucket, not the raw instant.
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return value;
  const halfHour = 30 * 60_000;
  return new Date(Math.round(ms / halfHour) * halfHour).toISOString();
}

function assertDeliveredTick(
  _status: number,
  body: unknown,
): string | undefined {
  const checkins = readSleepCycleCheckins(body);
  if (typeof checkins === "string") return checkins;
  if (checkins.length !== 1 || checkins[0]?.kind !== "morning") {
    return (
      `expected exactly one due morning check-in on the delivery tick, saw ${JSON.stringify(checkins)}; ` +
      "the seeded wake observation should make it due"
    );
  }
  const checkin = checkins[0];
  if (checkin.status !== "delivered") {
    return (
      `expected the due morning check-in to be delivered, saw ${JSON.stringify(checkin)}; ` +
      "an unplanned disconnected result must not hide in a green tick (#29068)"
    );
  }
  if (!checkin.persisted || !checkin.reportId) {
    return `expected delivery + persistence, saw ${JSON.stringify(checkin)}`;
  }
  if (!checkin.messageId?.startsWith("assistant-stream:")) {
    return `expected in-app delivery messageId assistant-stream:<reportId>, saw ${JSON.stringify(checkin.messageId)}`;
  }
  const sleepFailure = readSubsystemFailures(body).find((subsystem) =>
    subsystem.startsWith("sleep_cycle"),
  );
  if (sleepFailure) {
    return `unexpected sleep_cycle subsystem failure on a delivered tick: ${sleepFailure}`;
  }
  deliveredReportId = checkin.reportId;
  // Event ledger must already carry the delivered event (emit is
  // synchronous inside the tick).
  if (eventLedger.length !== 1) {
    return (
      `expected exactly one assistant event, saw ${eventLedger.length}; ` +
      "duplicate ticks must not duplicate delivery"
    );
  }
  const event = eventLedger[0];
  if (event.source !== "lifeops-checkin") {
    return `expected event source lifeops-checkin, saw ${JSON.stringify(event.source)}`;
  }
  if (event.reportId !== deliveredReportId) {
    return (
      `event report identity ${JSON.stringify(event.reportId)} does not match ` +
      `the delivered report ${deliveredReportId}`
    );
  }
  if (
    event.checkinKind !== "morning" ||
    event.deliveryBasis !== "sleep_cycle"
  ) {
    return (
      "event payload must carry the check-in identity: " +
      JSON.stringify({
        checkinKind: event.checkinKind,
        deliveryBasis: event.deliveryBasis,
      })
    );
  }
  if (event.agentId && runtimeAgentId && event.agentId !== runtimeAgentId) {
    return `event agentId ${event.agentId} does not match the runtime agent ${runtimeAgentId}`;
  }
  return undefined;
}

let runtimeAgentId: string | null = null;

function assertDedupeTick(_status: number, body: unknown): string | undefined {
  const checkins = readSleepCycleCheckins(body);
  if (typeof checkins === "string") return checkins;
  if (checkins.length !== 1 || checkins[0]?.kind !== "morning") {
    return `expected the duplicate tick to visit the morning check-in once, saw ${JSON.stringify(checkins)}`;
  }
  const checkin = checkins[0];
  if (checkin.status !== "skipped_already_sent") {
    return (
      `expected the duplicate tick to dedupe (skipped_already_sent), saw ${JSON.stringify(checkin)}; ` +
      "duplicate ticks cannot duplicate delivery or persistence"
    );
  }
  if (eventLedger.length !== 1) {
    return `the dedupe tick must not emit a second assistant event, saw ${eventLedger.length}`;
  }
  const sleepFailure = readSubsystemFailures(body).find((subsystem) =>
    subsystem.startsWith("sleep_cycle"),
  );
  if (sleepFailure) {
    return `a skipped-duplicate must not surface as a subsystem failure: ${sleepFailure}`;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Final checks — authoritative report readback through the runtime DB
// ---------------------------------------------------------------------------
async function readCheckinReportRows(
  ctx: ScenarioContext,
): Promise<Array<Record<string, unknown>>> {
  const { executeRawSql } = await import(
    "@elizaos/plugin-personal-assistant/lifeops/sql"
  );
  const runtime = ctx.runtime as Parameters<typeof executeRawSql>[0];
  return executeRawSql(
    runtime,
    "SELECT id, kind, acknowledged_at FROM app_lifeops.life_checkin_reports ORDER BY generated_at_ms",
  );
}

async function assertSinglePersistedReport(
  ctx: ScenarioContext,
): Promise<string | undefined> {
  if (!deliveredReportId) return "delivery tick did not capture a report id";
  const rows = await readCheckinReportRows(ctx);
  if (rows.length !== 1) {
    return (
      `expected exactly one persisted check-in report row, saw ${rows.length}: ` +
      JSON.stringify(rows)
    );
  }
  const row = rows[0];
  if (row?.id !== deliveredReportId) {
    return (
      `persisted row id ${JSON.stringify(row?.id)} does not match the delivered ` +
      `report ${deliveredReportId}; the authoritative readback must agree with the event`
    );
  }
  if (row?.kind !== "morning") {
    return `expected persisted kind=morning, saw ${JSON.stringify(row?.kind)}`;
  }
  return undefined;
}

function assertEventOrder(): string | undefined {
  // The order/payload properties the issue demands: payload, source,
  // identity, order (single event: seq monotonic by construction, asserted
  // via the delivered-first invariant above), authoritative readback is the
  // other final check.
  if (eventLedger.length !== 1) {
    return `expected exactly one assistant event, saw ${eventLedger.length}`;
  }
  const event = eventLedger[0];
  if (!event.text || event.text.length === 0) {
    return "assistant event text payload is empty";
  }
  if (typeof event.seq !== "number" || event.seq < 1) {
    return `expected a positive per-run seq, saw ${JSON.stringify(event.seq)}`;
  }
  if (event.ts < WAKE_AT.getTime()) {
    return "assistant event predates the wake observation";
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Seeded observation — posted through the REAL REST surface so the merged
// schedule state derives exactly the way it does in production.
// ---------------------------------------------------------------------------
function buildWakeObservationBody(): Record<string, unknown> {
  return {
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
  };
}

function captureRuntimeAgentId(ctx: ScenarioContext): string | undefined {
  const runtime = ctx.runtime as RuntimeLike | undefined;
  if (!runtime?.agentId) return "scenario runtime is not available";
  runtimeAgentId = runtime.agentId;
  return undefined;
}

export default scenario({
  id: SCENARIO_ID,
  lane: "pr-deterministic",
  modelFixtures: {
    mode: "fixtures",
    fixtures: [
      {
        // The morning check-in summary renders through CheckinService's
        // `renderSummary` (TEXT_LARGE). The deterministic fixture returns
        // empty text so `renderSummary` falls back to its deterministic
        // collector summary — no invented facts, keyless execution.
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
    "A due sleep-cycle morning check-in is delivered to the assistant stream exactly once, persisted, and read back authoritatively",
  domain: "lifeops",
  tags: [
    "pr",
    "deterministic",
    "zero-cost",
    "lifeops",
    "sleep-cycle",
    "checkin",
    "observability",
  ],
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
      name: "capture the runtime agent id",
      apply: captureRuntimeAgentId,
    },
    {
      type: "custom",
      name: "subscribe the assistant event ledger through the production agent_event service",
      apply: seedAssistantEventLedger,
    },
  ],
  cleanup: [
    {
      type: "custom",
      name: "unsubscribe the assistant event ledger",
      apply: () => {
        unsubscribeLedger?.();
        unsubscribeLedger = null;
        return undefined;
      },
    },
  ],
  turns: [
    {
      kind: "api",
      name: "seed a wake observation through the real schedule-observations surface",
      method: "POST",
      path: "/api/lifeops/schedule/observations",
      body: buildWakeObservationBody(),
      expectedStatus: 200,
      assertResponse: (_status, body) => {
        if (!isRecord(body) || body.acceptedCount !== 1) {
          return `expected acceptedCount=1, saw ${JSON.stringify(body)}`;
        }
        const merged = isRecord(body.mergedState) ? body.mergedState : null;
        if (merged?.circadianState !== "awake") {
          return (
            "expected the merged schedule to be awake after the wake " +
            `observation, saw ${JSON.stringify(merged?.circadianState)}`
          );
        }
        if (merged.wakeAt !== bucketedIso(WAKE_AT.toISOString())) {
          return `expected merged wakeAt ${bucketedIso(WAKE_AT.toISOString())} (seeded instant bucketed to the 30-minute merge grid), saw ${JSON.stringify(merged.wakeAt)}`;
        }
        return undefined;
      },
    },
    {
      kind: "tick",
      name: "tick at dueness — the morning check-in delivers to the assistant stream and persists",
      worker: "lifeops_scheduler",
      options: { now: TICK_1.toISOString(), scheduledTaskLimit: 50 },
      assertResponse: assertDeliveredTick,
    },
    {
      kind: "tick",
      name: "duplicate tick — the day-dedupe suppresses re-delivery and re-persistence",
      worker: "lifeops_scheduler",
      options: { now: TICK_2.toISOString(), scheduledTaskLimit: 50 },
      assertResponse: assertDedupeTick,
    },
  ],
  finalChecks: [
    {
      type: "custom",
      name: "exactly one morning report row persisted with the delivered id",
      predicate: async (ctx: ScenarioContext) =>
        await assertSinglePersistedReport(ctx),
    },
    {
      type: "custom",
      name: "assistant event carries payload, source, identity, and order",
      predicate: assertEventOrder,
    },
  ],
});
