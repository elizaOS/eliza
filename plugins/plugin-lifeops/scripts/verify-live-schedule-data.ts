import type {
  GetLifeOpsScheduleMergedStateResponse,
  LifeOpsScheduleMergedState,
  LifeOpsScheduleObservation,
} from "../src/lifeops/schedule-sync-contracts.js";

const DEFAULT_API_BASE = "http://127.0.0.1:31337";
const DEFAULT_ROW_LIMIT = 1000;
const TABLE_PAGE_LIMIT = 500;
const SCHEDULE_OBSERVATION_BUCKET_MINUTES = 30;
const SCHEDULE_OBSERVATION_LOOKBACK_MS = 48 * 60 * 60 * 1_000;

const OBSERVATION_TTL_MS: Record<LifeOpsScheduleObservation["state"], number> =
  {
    probably_awake: 4 * 60 * 60 * 1_000,
    probably_sleeping: 8 * 60 * 60 * 1_000,
    woke_recently: 2 * 60 * 60 * 1_000,
    winding_down: 3 * 60 * 60 * 1_000,
    meal_window_likely: 6 * 60 * 60 * 1_000,
    ate_recently: 4 * 60 * 60 * 1_000,
    active_recently: 90 * 60 * 1_000,
  };

type TableRowsResponse<T> = {
  table: string;
  schema: string;
  rows: T[];
  columns: string[];
  total: number;
  offset: number;
  limit: number;
};

type ActivityEventRow = {
  id: string;
  agent_id: string;
  observed_at: string;
  event_kind: string;
  bundle_id: string;
  app_name: string;
  window_title: string | null;
  metadata_json: string;
  created_at: string;
};

type ActivitySignalRow = {
  id: string;
  agent_id: string;
  source: string;
  platform: string;
  state: string;
  observed_at: string;
  idle_state: string | null;
  idle_time_seconds: number | null;
  on_battery: boolean | null;
  metadata_json: string;
  created_at: string;
};

type BrowserSessionRow = {
  id: string;
  updated_at: string;
};

type ScreenTimeSessionRow = {
  id: string;
  updated_at: string;
};

type ObservationRow = {
  id: string;
  agent_id: string;
  origin: LifeOpsScheduleObservation["origin"];
  device_id: string;
  device_kind: LifeOpsScheduleObservation["deviceKind"];
  timezone: string;
  observed_at: string;
  window_start_at: string;
  window_end_at: string | null;
  state: LifeOpsScheduleObservation["state"];
  phase: LifeOpsScheduleObservation["phase"];
  meal_label: LifeOpsScheduleObservation["mealLabel"];
  confidence: number;
  metadata_json: string;
  created_at: string;
  updated_at: string;
};

type MergedStateRow = {
  id: string;
  agent_id: string;
  scope: LifeOpsScheduleMergedState["scope"];
  effective_day_key: string;
  local_date: string;
  timezone: string;
  merged_at: string;
  inferred_at: string;
  phase: LifeOpsScheduleMergedState["phase"];
  sleep_status: LifeOpsScheduleMergedState["sleepStatus"];
  is_probably_sleeping: boolean;
  sleep_confidence: number;
  current_sleep_started_at: string | null;
  last_sleep_started_at: string | null;
  last_sleep_ended_at: string | null;
  last_sleep_duration_minutes: number | null;
  typical_wake_hour: number | null;
  typical_sleep_hour: number | null;
  wake_at: string | null;
  first_active_at: string | null;
  last_active_at: string | null;
  last_meal_at: string | null;
  next_meal_label: string | null;
  next_meal_window_start_at: string | null;
  next_meal_window_end_at: string | null;
  next_meal_confidence: number;
  meals_json: string;
  observation_count: number;
  device_count: number;
  contributing_device_kinds_json: string;
  metadata_json: string;
  created_at: string;
  updated_at: string;
};

type VerificationIssue = {
  level: "failure" | "warning";
  message: string;
};

type VerificationReport = {
  ok: boolean;
  checkedAt: string;
  apiBase: string;
  timezone: string;
  mergedState: {
    phase: string | null;
    sleepStatus: string | null;
    isProbablySleeping: boolean;
    observationCount: number;
    deviceCount: number;
    firstActiveAt: string | null;
    lastActiveAt: string | null;
    nextMealLabel: string | null;
    nextMealWindowStartAt: string | null;
    nextMealWindowEndAt: string | null;
    nextMealConfidence: number | null;
  };
  coverage: {
    activityEvents: number;
    activitySignals: number;
    browserSessions: number;
    screenTimeSessions: number;
    activeObservationCount: number;
    activeObservationStates: string[];
    activeObservationDeviceKinds: string[];
    activeObservationDeviceIds: string[];
    signalSources: string[];
    recentApps: string[];
  };
  evidence: {
    latestActivityEventAt: string | null;
    earliestActivityEvidenceTodayAt: string | null;
    latestActiveSignalAt: string | null;
    latestObservationAt: string | null;
  };
  failures: string[];
  warnings: string[];
};

type Options = {
  apiBase: string;
  timezone: string;
  json: boolean;
};

function parseArgs(argv: string[]): Options {
  let apiBase = DEFAULT_API_BASE;
  let timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  let json = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "--api-base") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("--api-base requires a value");
      }
      apiBase = value;
      index += 1;
      continue;
    }
    if (arg === "--timezone") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("--timezone requires a value");
      }
      timezone = value;
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return { apiBase: apiBase.replace(/\/+$/, ""), timezone, json };
}

async function requestJson<T>(apiBase: string, pathname: string): Promise<T> {
  const response = await fetch(`${apiBase}${pathname}`);
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`${pathname} returned ${response.status}: ${body}`);
  }
  return (await response.json()) as T;
}

async function readTable<T>(args: {
  apiBase: string;
  table: string;
  sort: string;
  limit?: number;
  offset?: number;
  order?: "asc" | "desc";
}): Promise<TableRowsResponse<T>> {
  const params = new URLSearchParams({
    limit: String(args.limit ?? DEFAULT_ROW_LIMIT),
    offset: String(args.offset ?? 0),
    sort: args.sort,
    order: args.order ?? "desc",
  });
  return await requestJson<TableRowsResponse<T>>(
    args.apiBase,
    `/api/database/tables/${args.table}/rows?${params.toString()}`,
  );
}

async function readAllTable<T>(args: {
  apiBase: string;
  table: string;
  sort: string;
  order?: "asc" | "desc";
}): Promise<TableRowsResponse<T>> {
  const rows: T[] = [];
  let offset = 0;
  let schema = "public";
  let columns: string[] = [];
  let total = 0;
  while (true) {
    const page = await readTable<T>({
      ...args,
      limit: TABLE_PAGE_LIMIT,
      offset,
    });
    schema = page.schema;
    columns = page.columns;
    total = page.total;
    rows.push(...page.rows);
    offset += page.rows.length;
    if (page.rows.length === 0 || offset >= total) {
      break;
    }
  }
  return {
    table: args.table,
    schema,
    rows,
    columns,
    total,
    offset: 0,
    limit: rows.length,
  };
}

function parseIsoMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function localDateKey(iso: string, timezone: string): string {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return formatter.format(new Date(iso));
}

function formatLocal(
  iso: string | null | undefined,
  timezone: string,
): string | null {
  if (!iso) return null;
  const parsed = parseIsoMs(iso);
  if (parsed === null) return null;
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
    timeZoneName: "short",
  });
  return formatter.format(new Date(parsed));
}

function bucketDeltaMinutes(
  left: string | null | undefined,
  right: string | null | undefined,
): number | null {
  const leftMs = parseIsoMs(left);
  const rightMs = parseIsoMs(right);
  if (leftMs === null || rightMs === null) {
    return null;
  }
  return Math.abs(leftMs - rightMs) / 60_000;
}

function maxIso(values: Array<string | null | undefined>): string | null {
  let best: string | null = null;
  let bestMs = Number.NEGATIVE_INFINITY;
  for (const value of values) {
    const parsed = parseIsoMs(value);
    if (parsed === null || parsed <= bestMs) continue;
    bestMs = parsed;
    best = new Date(parsed).toISOString();
  }
  return best;
}

function minIso(values: Array<string | null | undefined>): string | null {
  let best: string | null = null;
  let bestMs = Number.POSITIVE_INFINITY;
  for (const value of values) {
    const parsed = parseIsoMs(value);
    if (parsed === null || parsed >= bestMs) continue;
    bestMs = parsed;
    best = new Date(parsed).toISOString();
  }
  return best;
}

function formatLine(
  label: string,
  value: string | number | boolean | null,
): string {
  const rendered =
    value === null
      ? "null"
      : typeof value === "boolean"
        ? String(value)
        : String(value);
  return `${label.padEnd(28)} ${rendered}`;
}

function topRecentApps(
  rows: ActivityEventRow[],
  timezone: string,
  localDate: string | null,
): string[] {
  if (!localDate) return [];
  const counts = new Map<string, number>();
  for (const row of rows) {
    if (localDateKey(row.observed_at, timezone) !== localDate) continue;
    counts.set(row.app_name, (counts.get(row.app_name) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort(
      (left, right) => right[1] - left[1] || left[0].localeCompare(right[0]),
    )
    .slice(0, 5)
    .map(([name, count]) => `${name} (${count})`);
}

function normalizeObservation(row: ObservationRow): LifeOpsScheduleObservation {
  return {
    id: row.id,
    agentId: row.agent_id,
    origin: row.origin,
    deviceId: row.device_id,
    deviceKind: row.device_kind,
    timezone: row.timezone,
    observedAt: row.observed_at,
    windowStartAt: row.window_start_at,
    windowEndAt: row.window_end_at,
    state: row.state,
    phase: row.phase,
    mealLabel: row.meal_label,
    confidence: Number(row.confidence),
    metadata: {},
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function isObservationActive(
  observation: LifeOpsScheduleObservation,
  mergedAtMs: number,
): boolean {
  const observedAtMs = parseIsoMs(observation.observedAt);
  if (observedAtMs === null) return false;
  if (mergedAtMs - observedAtMs > SCHEDULE_OBSERVATION_LOOKBACK_MS)
    return false;
  return mergedAtMs - observedAtMs <= OBSERVATION_TTL_MS[observation.state];
}

function buildReport(args: {
  apiBase: string;
  timezone: string;
  mergedState: LifeOpsScheduleMergedState;
  mergedStateRow: MergedStateRow | null;
  observations: ObservationRow[];
  observationTotal: number;
  activityEvents: ActivityEventRow[];
  activityEventTotal: number;
  activitySignals: ActivitySignalRow[];
  activitySignalTotal: number;
  browserSessionTotal: number;
  screenTimeSessionTotal: number;
}): VerificationReport {
  const issues: VerificationIssue[] = [];
  const mergedAtMs = parseIsoMs(args.mergedState.mergedAt);
  if (mergedAtMs === null) {
    issues.push({
      level: "failure",
      message: "Merged schedule state has an invalid mergedAt timestamp.",
    });
  }

  const normalizedObservations = args.observations.map(normalizeObservation);
  const activeObservations =
    mergedAtMs === null
      ? []
      : normalizedObservations.filter((observation) =>
          isObservationActive(observation, mergedAtMs),
        );
  const activeObservationStates = [
    ...new Set(activeObservations.map((row) => row.state)),
  ].sort();
  const activeObservationDeviceKinds = [
    ...new Set(activeObservations.map((row) => row.deviceKind)),
  ].sort();
  const activeObservationDeviceIds = [
    ...new Set(activeObservations.map((row) => row.deviceId)),
  ].sort();
  const latestObservationAt = maxIso(
    activeObservations.map((row) => row.observedAt),
  );

  if (args.observationTotal === 0) {
    issues.push({
      level: "failure",
      message:
        "No schedule observations are stored. Local schedule inference is not persisting evidence.",
    });
  }
  if (args.mergedState.observationCount !== activeObservations.length) {
    issues.push({
      level: "failure",
      message: `Merged observationCount=${args.mergedState.observationCount} but ${activeObservations.length} active observations were found.`,
    });
  }
  if (args.mergedState.deviceCount !== activeObservationDeviceIds.length) {
    issues.push({
      level: "failure",
      message: `Merged deviceCount=${args.mergedState.deviceCount} but ${activeObservationDeviceIds.length} active device ids were found.`,
    });
  }

  const mergedKinds = [...args.mergedState.contributingDeviceKinds].sort();
  if (
    JSON.stringify(mergedKinds) !== JSON.stringify(activeObservationDeviceKinds)
  ) {
    issues.push({
      level: "failure",
      message: `Merged contributingDeviceKinds=${mergedKinds.join(", ")} but active observations show ${activeObservationDeviceKinds.join(", ")}.`,
    });
  }

  const metadataLatestObservationAt =
    typeof args.mergedState.metadata.latestObservationAt === "string"
      ? args.mergedState.metadata.latestObservationAt
      : null;
  if (metadataLatestObservationAt !== latestObservationAt) {
    issues.push({
      level: "failure",
      message: `Merged metadata latestObservationAt=${metadataLatestObservationAt ?? "null"} does not match the latest active observation ${latestObservationAt ?? "null"}.`,
    });
  }
  if (!args.mergedStateRow) {
    issues.push({
      level: "failure",
      message:
        "life_schedule_merged_states does not contain a persisted row for the merged state route response.",
    });
  } else {
    if (args.mergedStateRow.id !== args.mergedState.id) {
      issues.push({
        level: "failure",
        message: `Merged state route returned id=${args.mergedState.id} but the stored row is ${args.mergedStateRow.id}.`,
      });
    }
    if (args.mergedStateRow.updated_at !== args.mergedState.updatedAt) {
      issues.push({
        level: "failure",
        message: `Merged state route updatedAt=${args.mergedState.updatedAt} does not match the stored row ${args.mergedStateRow.updated_at}.`,
      });
    }
  }

  if (args.activityEventTotal === 0) {
    issues.push({
      level: "failure",
      message:
        "No life_activity_events are stored. macOS application tracking is not feeding the predictor.",
    });
  }

  const activeSignals = args.activitySignals.filter(
    (row) => row.state === "active",
  );
  const latestActivityEventAt = maxIso(
    args.activityEvents.map((row) => row.observed_at),
  );
  const latestActiveSignalAt = maxIso(
    activeSignals.map((row) => row.observed_at),
  );
  const todayEventRows = args.activityEvents.filter(
    (row) =>
      localDateKey(row.observed_at, args.timezone) ===
      args.mergedState.localDate,
  );
  const todayActiveSignals = activeSignals.filter(
    (row) =>
      localDateKey(row.observed_at, args.timezone) ===
      args.mergedState.localDate,
  );
  const earliestActivityEvidenceTodayAt = minIso([
    ...todayEventRows.map((row) => row.observed_at),
    ...todayActiveSignals.map((row) => row.observed_at),
  ]);
  const latestActivityEvidenceAt = maxIso([
    latestActivityEventAt,
    latestActiveSignalAt,
  ]);

  const lastActiveDelta = bucketDeltaMinutes(
    args.mergedState.lastActiveAt,
    latestActivityEvidenceAt,
  );
  if (
    latestActivityEvidenceAt &&
    (lastActiveDelta === null ||
      lastActiveDelta > SCHEDULE_OBSERVATION_BUCKET_MINUTES)
  ) {
    issues.push({
      level: "failure",
      message: `Merged lastActiveAt is ${lastActiveDelta === null ? "unavailable" : `${Math.round(lastActiveDelta)} minutes`} away from the latest activity evidence.`,
    });
  }

  const firstActiveDelta = bucketDeltaMinutes(
    args.mergedState.firstActiveAt,
    earliestActivityEvidenceTodayAt,
  );
  if (
    earliestActivityEvidenceTodayAt &&
    (firstActiveDelta === null ||
      firstActiveDelta > SCHEDULE_OBSERVATION_BUCKET_MINUTES)
  ) {
    issues.push({
      level: "failure",
      message: `Merged firstActiveAt is ${firstActiveDelta === null ? "unavailable" : `${Math.round(firstActiveDelta)} minutes`} away from the earliest active evidence for the local day.`,
    });
  }

  if (args.screenTimeSessionTotal === 0) {
    issues.push({
      level: "warning",
      message:
        "life_screen_time_sessions is empty, so there is no persisted browser/app screen-time evidence in the merged schedule yet.",
    });
  }
  if (args.browserSessionTotal === 0) {
    issues.push({
      level: "warning",
      message:
        "life_browser_sessions is empty, so browser companion telemetry is not contributing any coverage yet.",
    });
  }
  if (
    activeObservationDeviceKinds.length <= 1 &&
    activeObservationDeviceKinds[0] === "mac"
  ) {
    issues.push({
      level: "warning",
      message:
        "All active schedule observations come from the Mac. Cross-device fusion is not being exercised by the current real dataset.",
    });
  }
  if (
    args.mergedState.sleepStatus !== "slept" &&
    args.mergedState.sleepStatus !== "probably_sleeping"
  ) {
    issues.push({
      level: "warning",
      message: `Sleep status is ${args.mergedState.sleepStatus}, which means the current dataset does not yet provide enough overnight evidence for a confident sleep interval.`,
    });
  }
  if (
    args.mergedState.nextMealConfidence > 0 &&
    args.screenTimeSessionTotal === 0
  ) {
    issues.push({
      level: "warning",
      message:
        "Meal guidance is currently being inferred without any browser/screen-time sessions, so the dinner window is a weak time-of-day heuristic rather than multimodal evidence.",
    });
  }

  const signalSources = [
    ...new Set(
      args.activitySignals.map(
        (row) => `${row.platform}:${row.source}:${row.state}`,
      ),
    ),
  ].sort();
  const recentApps = topRecentApps(
    args.activityEvents,
    args.timezone,
    args.mergedState.localDate,
  );

  return {
    ok: !issues.some((issue) => issue.level === "failure"),
    checkedAt: new Date().toISOString(),
    apiBase: args.apiBase,
    timezone: args.timezone,
    mergedState: {
      phase: args.mergedState.phase,
      sleepStatus: args.mergedState.sleepStatus,
      isProbablySleeping: args.mergedState.isProbablySleeping,
      observationCount: args.mergedState.observationCount,
      deviceCount: args.mergedState.deviceCount,
      firstActiveAt: formatLocal(args.mergedState.firstActiveAt, args.timezone),
      lastActiveAt: formatLocal(args.mergedState.lastActiveAt, args.timezone),
      nextMealLabel: args.mergedState.nextMealLabel,
      nextMealWindowStartAt: formatLocal(
        args.mergedState.nextMealWindowStartAt,
        args.timezone,
      ),
      nextMealWindowEndAt: formatLocal(
        args.mergedState.nextMealWindowEndAt,
        args.timezone,
      ),
      nextMealConfidence: args.mergedState.nextMealConfidence,
    },
    coverage: {
      activityEvents: args.activityEventTotal,
      activitySignals: args.activitySignalTotal,
      browserSessions: args.browserSessionTotal,
      screenTimeSessions: args.screenTimeSessionTotal,
      activeObservationCount: activeObservations.length,
      activeObservationStates,
      activeObservationDeviceKinds,
      activeObservationDeviceIds,
      signalSources,
      recentApps,
    },
    evidence: {
      latestActivityEventAt: formatLocal(latestActivityEventAt, args.timezone),
      earliestActivityEvidenceTodayAt: formatLocal(
        earliestActivityEvidenceTodayAt,
        args.timezone,
      ),
      latestActiveSignalAt: formatLocal(latestActiveSignalAt, args.timezone),
      latestObservationAt: formatLocal(latestObservationAt, args.timezone),
    },
    failures: issues
      .filter((issue) => issue.level === "failure")
      .map((issue) => issue.message),
    warnings: issues
      .filter((issue) => issue.level === "warning")
      .map((issue) => issue.message),
  };
}

function printReport(report: VerificationReport): void {
  console.log(
    report.ok
      ? "LifeOps live schedule verification: PASS"
      : "LifeOps live schedule verification: FAIL",
  );
  console.log(formatLine("API base", report.apiBase));
  console.log(formatLine("Timezone", report.timezone));
  console.log(formatLine("Checked at", report.checkedAt));
  console.log("");
  console.log("Merged state");
  console.log(formatLine("Phase", report.mergedState.phase));
  console.log(formatLine("Sleep status", report.mergedState.sleepStatus));
  console.log(
    formatLine("Probably sleeping", report.mergedState.isProbablySleeping),
  );
  console.log(
    formatLine("Observation count", report.mergedState.observationCount),
  );
  console.log(formatLine("Device count", report.mergedState.deviceCount));
  console.log(formatLine("First active", report.mergedState.firstActiveAt));
  console.log(formatLine("Last active", report.mergedState.lastActiveAt));
  console.log(formatLine("Next meal", report.mergedState.nextMealLabel));
  console.log(
    formatLine("Meal window start", report.mergedState.nextMealWindowStartAt),
  );
  console.log(
    formatLine("Meal window end", report.mergedState.nextMealWindowEndAt),
  );
  console.log(
    formatLine("Meal confidence", report.mergedState.nextMealConfidence),
  );
  console.log("");
  console.log("Coverage");
  console.log(formatLine("Activity events", report.coverage.activityEvents));
  console.log(formatLine("Activity signals", report.coverage.activitySignals));
  console.log(formatLine("Browser sessions", report.coverage.browserSessions));
  console.log(
    formatLine("Screen-time sessions", report.coverage.screenTimeSessions),
  );
  console.log(
    formatLine("Active observations", report.coverage.activeObservationCount),
  );
  console.log(
    formatLine(
      "Observation states",
      report.coverage.activeObservationStates.join(", "),
    ),
  );
  console.log(
    formatLine(
      "Observation devices",
      report.coverage.activeObservationDeviceKinds.join(", "),
    ),
  );
  console.log(
    formatLine("Signal sources", report.coverage.signalSources.join(", ")),
  );
  console.log(formatLine("Recent apps", report.coverage.recentApps.join(", ")));
  console.log("");
  console.log("Evidence");
  console.log(
    formatLine("Latest event", report.evidence.latestActivityEventAt),
  );
  console.log(
    formatLine(
      "First active evidence",
      report.evidence.earliestActivityEvidenceTodayAt,
    ),
  );
  console.log(
    formatLine("Latest active signal", report.evidence.latestActiveSignalAt),
  );
  console.log(
    formatLine("Latest observation", report.evidence.latestObservationAt),
  );

  if (report.failures.length > 0) {
    console.log("");
    console.log("Failures");
    for (const failure of report.failures) {
      console.log(`- ${failure}`);
    }
  }

  if (report.warnings.length > 0) {
    console.log("");
    console.log("Warnings");
    for (const warning of report.warnings) {
      console.log(`- ${warning}`);
    }
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const mergedStateResponse =
    await requestJson<GetLifeOpsScheduleMergedStateResponse>(
      options.apiBase,
      `/api/lifeops/schedule/merged-state?scope=local&refresh=1&timezone=${encodeURIComponent(options.timezone)}`,
    );

  if (!mergedStateResponse.mergedState) {
    throw new Error("Merged state route returned null.");
  }

  const [
    mergedStateRows,
    observationRows,
    activityEventRows,
    activitySignalRows,
    browserSessionRows,
    screenTimeSessionRows,
  ] = await Promise.all([
    readTable<MergedStateRow>({
      apiBase: options.apiBase,
      table: "life_schedule_merged_states",
      sort: "merged_at",
      limit: 5,
    }),
    readTable<ObservationRow>({
      apiBase: options.apiBase,
      table: "life_schedule_observations",
      sort: "observed_at",
      limit: 200,
    }),
    readAllTable<ActivityEventRow>({
      apiBase: options.apiBase,
      table: "life_activity_events",
      sort: "observed_at",
    }),
    readAllTable<ActivitySignalRow>({
      apiBase: options.apiBase,
      table: "life_activity_signals",
      sort: "observed_at",
    }),
    readTable<BrowserSessionRow>({
      apiBase: options.apiBase,
      table: "life_browser_sessions",
      sort: "updated_at",
      limit: 50,
    }),
    readTable<ScreenTimeSessionRow>({
      apiBase: options.apiBase,
      table: "life_screen_time_sessions",
      sort: "updated_at",
      limit: 50,
    }),
  ]);

  const report = buildReport({
    apiBase: options.apiBase,
    timezone: options.timezone,
    mergedState: mergedStateResponse.mergedState,
    mergedStateRow: mergedStateRows.rows[0] ?? null,
    observations: observationRows.rows,
    observationTotal: observationRows.total,
    activityEvents: activityEventRows.rows,
    activityEventTotal: activityEventRows.total,
    activitySignals: activitySignalRows.rows,
    activitySignalTotal: activitySignalRows.total,
    browserSessionTotal: browserSessionRows.total,
    screenTimeSessionTotal: screenTimeSessionRows.total,
  });

  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printReport(report);
  }

  if (!report.ok) {
    process.exitCode = 1;
  }
}

await main();
