import { randomUUID } from "node:crypto";
import type { MatchRecord, MeetingRecord, SafetyReport } from "@engine/types";
import { computeAnalytics } from "@/lib/analytics";
import {
  type AnalyticsSnapshot,
  listAnalyticsSnapshots,
} from "@/lib/analytics-store";
import type { AnalyticsSummary } from "@/lib/analytics-types";
import { badRequest, ok, serverError, unauthorized } from "@/lib/api-utils";
import { getUsersByPersonaIds, loadEngineState } from "@/lib/engine-store";
import { requireAdminUser } from "@/lib/session";
import { listUsers, type UserRecord } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type ExportFormat = "json" | "csv";
type ExportDataset =
  | "users"
  | "matches"
  | "meetings"
  | "safety"
  | "analytics"
  | "all";

type CsvRow = Record<string, string | number | boolean | null>;
type ExportJobStatus = "pending" | "ready" | "failed";

type ExportJsonPayload = {
  users?: UserRecord[];
  matches?: MatchRecord[];
  meetings?: MeetingRecord[];
  safety?: SafetyReport[];
  analytics?: AnalyticsSummary;
  snapshots?: AnalyticsSnapshot[];
};

type ExportJob = {
  id: string;
  status: ExportJobStatus;
  format: ExportFormat;
  dataset: ExportDataset;
  createdAt: number;
  filename: string;
  csv?: string;
  json?: ExportJsonPayload;
  error?: string;
};

type ExportFilters = {
  q: string;
  userStatus?: string;
  isAdmin?: boolean;
  createdAfter: number | null;
  createdBefore: number | null;
  matchStatus?: string;
  domain?: string;
  safetyStatus?: string;
  severity?: string;
  includeSnapshots: boolean;
  snapshotDays: number;
};

const jobs = new Map<string, ExportJob>();
const JOB_TTL_MS = 30 * 60 * 1000;

const cleanupJobs = (): void => {
  const now = Date.now();
  for (const [jobId, job] of jobs.entries()) {
    if (now - job.createdAt > JOB_TTL_MS) {
      jobs.delete(jobId);
    }
  }
};

const parseBoolean = (value: string | null): boolean | undefined => {
  if (value === "true") return true;
  if (value === "false") return false;
  return undefined;
};

const parseDate = (value: string | null): number | null => {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const clampNumber = (value: number, min: number, max: number): number =>
  Math.min(Math.max(value, min), max);

const toCsv = (rows: CsvRow[]): string => {
  if (rows.length === 0) return "";
  const headers = Object.keys(rows[0]);
  const escapeCsvValue = (value: string | number | boolean | null): string => {
    if (value === null) return "";
    const text = String(value);
    const escaped = text.replace(/"/g, '""');
    return `"${escaped}"`;
  };
  const lines = [
    headers.join(","),
    ...rows.map((row) =>
      headers.map((key) => escapeCsvValue(row[key])).join(","),
    ),
  ];
  return lines.join("\n");
};

const buildUserRows = (
  users: Awaited<ReturnType<typeof listUsers>>,
): CsvRow[] =>
  users.map((user) => ({
    id: user.id,
    phone: user.phone,
    name: user.name ?? "",
    email: user.email ?? "",
    location: user.location ?? "",
    status: user.status,
    credits: user.credits,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  }));

const buildMatchRows = (
  matches: MatchRecord[],
  meetings: MeetingRecord[],
  userMap: Map<number, { phone: string; name: string | null }>,
): CsvRow[] =>
  matches.map((match) => {
    const meeting = match.scheduledMeetingId
      ? meetings.find((entry) => entry.meetingId === match.scheduledMeetingId)
      : undefined;
    const userA = userMap.get(match.personaA);
    const userB = userMap.get(match.personaB);
    return {
      matchId: match.matchId,
      status: match.status,
      domain: match.domain,
      score: match.assessment.score,
      createdAt: match.createdAt,
      personaAId: match.personaA,
      personaAName: userA?.name ?? "",
      personaAPhone: userA?.phone ?? "",
      personaBId: match.personaB,
      personaBName: userB?.name ?? "",
      personaBPhone: userB?.phone ?? "",
      meetingId: meeting?.meetingId ?? "",
      scheduledAt: meeting?.scheduledAt ?? "",
      meetingStatus: meeting?.status ?? "",
      locationName: meeting?.location.name ?? "",
      locationAddress: meeting?.location.address ?? "",
    };
  });

const buildMeetingRows = (meetings: MeetingRecord[]): CsvRow[] =>
  meetings.map((meeting) => ({
    meetingId: meeting.meetingId,
    matchId: meeting.matchId,
    status: meeting.status,
    scheduledAt: meeting.scheduledAt,
    locationName: meeting.location.name,
    locationAddress: meeting.location.address,
    rescheduleCount: meeting.rescheduleCount,
    cancellationReason: meeting.cancellationReason ?? "",
  }));

const buildSafetyRows = (reports: SafetyReport[]): CsvRow[] =>
  reports.map((report) => ({
    reportId: report.reportId,
    severity: report.severity,
    status: report.status,
    createdAt: report.createdAt,
    reporterId: report.reporterId,
    targetId: report.targetId,
    notes: report.notes,
    transcriptRef: report.transcriptRef ?? "",
  }));

const buildAnalyticsRows = (analytics: AnalyticsSummary): CsvRow[] => [
  {
    users_total: analytics.users.total,
    users_active: analytics.users.active,
    users_pending: analytics.users.pending,
    users_blocked: analytics.users.blocked,
    matches_total: analytics.matches.total,
    matches_proposed: analytics.matches.proposed,
    matches_accepted: analytics.matches.accepted,
    matches_scheduled: analytics.matches.scheduled,
    matches_completed: analytics.matches.completed,
    matches_canceled: analytics.matches.canceled,
    matches_expired: analytics.matches.expired,
    meetings_total: analytics.meetings.total,
    meetings_scheduled: analytics.meetings.scheduled,
    meetings_completed: analytics.meetings.completed,
    meetings_canceled: analytics.meetings.canceled,
    meetings_no_show: analytics.meetings.no_show,
    meetings_completion_rate: analytics.meetings.completionRate,
    meetings_reschedules: analytics.meetings.reschedules,
    feedback_total: analytics.feedback.total,
    feedback_positive: analytics.feedback.positive,
    feedback_neutral: analytics.feedback.neutral,
    feedback_negative: analytics.feedback.negative,
    feedback_positive_rate: analytics.feedback.positiveRate,
    reliability_average: analytics.reliability.averageScore,
    reliability_low: analytics.reliability.lowCount,
    reliability_high: analytics.reliability.highCount,
    retention_day7: analytics.retention.day7,
    retention_day30: analytics.retention.day30,
    repeat_meeting_rate: analytics.repeatMeetingRate,
    cancellations_total: analytics.cancellations.total,
    cancellations_late: analytics.cancellations.late,
    safety_total: analytics.safety.total,
    safety_open: analytics.safety.open,
    safety_reviewing: analytics.safety.reviewing,
    safety_resolved: analytics.safety.resolved,
    safety_level1: analytics.safety.level1,
    safety_level2: analytics.safety.level2,
    safety_level3: analytics.safety.level3,
  },
];

const buildAnalyticsSnapshotRows = (snapshots: AnalyticsSnapshot[]): CsvRow[] =>
  snapshots.map((snapshot) => ({
    day: snapshot.day,
    users_active: snapshot.summary.users.active,
    matches_total: snapshot.summary.matches.total,
    meetings_completion_rate: snapshot.summary.meetings.completionRate,
    safety_open: snapshot.summary.safety.open,
  }));

const buildAllRows = (
  users: Awaited<ReturnType<typeof listUsers>>,
  matches: MatchRecord[],
  meetings: MeetingRecord[],
  safetyReports: SafetyReport[],
  analytics: AnalyticsSummary,
  snapshots: AnalyticsSnapshot[],
): CsvRow[] => [
  ...users.map((user) => ({ type: "user", payload: JSON.stringify(user) })),
  ...matches.map((match) => ({
    type: "match",
    payload: JSON.stringify(match),
  })),
  ...meetings.map((meeting) => ({
    type: "meeting",
    payload: JSON.stringify(meeting),
  })),
  ...safetyReports.map((report) => ({
    type: "safety",
    payload: JSON.stringify(report),
  })),
  { type: "analytics", payload: JSON.stringify(analytics) },
  ...snapshots.map((snapshot) => ({
    type: "analytics_snapshot",
    payload: JSON.stringify(snapshot),
  })),
];

const filterUsers = (
  users: UserRecord[],
  filters: ExportFilters,
): UserRecord[] =>
  users.filter((user) => {
    if (filters.userStatus && user.status.toLowerCase() !== filters.userStatus)
      return false;
    if (filters.isAdmin !== undefined && user.isAdmin !== filters.isAdmin)
      return false;
    const createdAt = Date.parse(user.createdAt);
    if (filters.createdAfter !== null && createdAt < filters.createdAfter)
      return false;
    if (filters.createdBefore !== null && createdAt >= filters.createdBefore)
      return false;
    if (filters.q) {
      const haystack =
        `${user.name ?? ""} ${user.phone} ${user.email ?? ""}`.toLowerCase();
      if (!haystack.includes(filters.q)) return false;
    }
    return true;
  });

const filterMatches = (
  matches: MatchRecord[],
  filters: ExportFilters,
  userMap: Map<number, { phone: string; name: string | null }>,
): MatchRecord[] =>
  matches.filter((match) => {
    if (
      filters.matchStatus &&
      match.status.toLowerCase() !== filters.matchStatus
    )
      return false;
    if (filters.domain && match.domain.toLowerCase() !== filters.domain)
      return false;
    const createdAt = Date.parse(match.createdAt);
    if (filters.createdAfter !== null && createdAt < filters.createdAfter)
      return false;
    if (filters.createdBefore !== null && createdAt >= filters.createdBefore)
      return false;
    if (filters.q) {
      const userA = userMap.get(match.personaA);
      const userB = userMap.get(match.personaB);
      const haystack = [
        match.matchId,
        match.domain,
        userA?.name ?? "",
        userA?.phone ?? "",
        userB?.name ?? "",
        userB?.phone ?? "",
      ]
        .join(" ")
        .toLowerCase();
      if (!haystack.includes(filters.q)) return false;
    }
    return true;
  });

const filterSafety = (
  reports: SafetyReport[],
  filters: ExportFilters,
  userMap: Map<number, { phone: string | null; name: string | null }>,
): SafetyReport[] =>
  reports.filter((report) => {
    if (
      filters.safetyStatus &&
      report.status.toLowerCase() !== filters.safetyStatus
    )
      return false;
    if (filters.severity && report.severity.toLowerCase() !== filters.severity)
      return false;
    const createdAt = Date.parse(report.createdAt);
    if (filters.createdAfter !== null && createdAt < filters.createdAfter)
      return false;
    if (filters.createdBefore !== null && createdAt >= filters.createdBefore)
      return false;
    if (filters.q) {
      const reporter = userMap.get(report.reporterId);
      const target = userMap.get(report.targetId);
      const haystack = [
        report.reportId,
        report.notes,
        reporter?.name ?? "",
        reporter?.phone ?? "",
        target?.name ?? "",
        target?.phone ?? "",
      ]
        .join(" ")
        .toLowerCase();
      if (!haystack.includes(filters.q)) return false;
    }
    return true;
  });

const buildExport = async (
  dataset: ExportDataset,
  format: ExportFormat,
  filters: ExportFilters,
): Promise<{ csv?: string; json?: ExportJsonPayload; filename: string }> => {
  const [users, record] = await Promise.all([listUsers(), loadEngineState()]);
  const analytics = computeAnalytics(users, record.state);
  const snapshots = filters.includeSnapshots
    ? await listAnalyticsSnapshots(filters.snapshotDays)
    : [];

  const personaIds = Array.from(
    new Set(
      record.state.matches.flatMap((match) => [match.personaA, match.personaB]),
    ),
  );
  const personaUsers =
    personaIds.length > 0 ? await getUsersByPersonaIds(personaIds) : [];
  const userMap = new Map<number, { phone: string; name: string | null }>();
  for (const user of personaUsers) {
    userMap.set(user.personaId, { phone: user.phone, name: user.name });
  }

  const safetyPersonaIds = Array.from(
    new Set(
      record.state.safetyReports.flatMap((report) => [
        report.reporterId,
        report.targetId,
      ]),
    ),
  );
  const safetyUsers =
    safetyPersonaIds.length > 0
      ? await getUsersByPersonaIds(safetyPersonaIds)
      : [];
  const safetyUserMap = new Map<
    number,
    { phone: string | null; name: string | null }
  >();
  for (const user of safetyUsers) {
    safetyUserMap.set(user.personaId, { phone: user.phone, name: user.name });
  }

  const filteredUsers = filterUsers(users, filters);
  const filteredMatches = filterMatches(record.state.matches, filters, userMap);
  const filteredSafety = filterSafety(
    record.state.safetyReports,
    filters,
    safetyUserMap,
  );

  if (format === "csv") {
    const csv =
      dataset === "users"
        ? toCsv(buildUserRows(filteredUsers))
        : dataset === "matches"
          ? toCsv(
              buildMatchRows(filteredMatches, record.state.meetings, userMap),
            )
          : dataset === "meetings"
            ? toCsv(buildMeetingRows(record.state.meetings))
            : dataset === "safety"
              ? toCsv(buildSafetyRows(filteredSafety))
              : dataset === "analytics"
                ? filters.includeSnapshots && snapshots.length > 0
                  ? toCsv(buildAnalyticsSnapshotRows(snapshots))
                  : toCsv(buildAnalyticsRows(analytics))
                : dataset === "all"
                  ? toCsv(
                      buildAllRows(
                        filteredUsers,
                        filteredMatches,
                        record.state.meetings,
                        filteredSafety,
                        analytics,
                        snapshots,
                      ),
                    )
                  : "";
    return { csv, filename: `${dataset}.csv` };
  }

  const payload: ExportJsonPayload =
    dataset === "users"
      ? { users: filteredUsers }
      : dataset === "matches"
        ? { matches: filteredMatches }
        : dataset === "meetings"
          ? { meetings: record.state.meetings }
          : dataset === "safety"
            ? { safety: filteredSafety }
            : dataset === "analytics"
              ? {
                  analytics,
                  snapshots: filters.includeSnapshots ? snapshots : undefined,
                }
              : {
                  users: filteredUsers,
                  matches: filteredMatches,
                  meetings: record.state.meetings,
                  safety: filteredSafety,
                  analytics,
                  snapshots: filters.includeSnapshots ? snapshots : undefined,
                };

  return { json: payload, filename: `${dataset}.json` };
};

const startExportJob = async (
  dataset: ExportDataset,
  format: ExportFormat,
  filters: ExportFilters,
): Promise<ExportJob> => {
  const id = randomUUID();
  const job: ExportJob = {
    id,
    status: "pending",
    format,
    dataset,
    createdAt: Date.now(),
    filename: `${dataset}.${format}`,
  };
  jobs.set(id, job);

  void (async () => {
    try {
      const result = await buildExport(dataset, format, filters);
      jobs.set(id, {
        ...job,
        status: "ready",
        csv: result.csv,
        json: result.json,
        filename: result.filename,
      });
    } catch (error) {
      jobs.set(id, {
        ...job,
        status: "failed",
        error: error instanceof Error ? error.message : "Export failed",
      });
    }
  })();

  return job;
};

export async function GET(request: Request) {
  const admin = await requireAdminUser();
  if (!admin) return unauthorized();

  const url = new URL(request.url);
  const formatParam = url.searchParams.get("format");
  const format: ExportFormat = formatParam === "csv" ? "csv" : "json";
  const datasetParam = url.searchParams.get("dataset");
  const dataset: ExportDataset =
    datasetParam === "users" ||
    datasetParam === "matches" ||
    datasetParam === "meetings" ||
    datasetParam === "safety" ||
    datasetParam === "analytics" ||
    datasetParam === "all"
      ? datasetParam
      : "all";
  const asyncMode = url.searchParams.get("async") === "true";
  const jobId = url.searchParams.get("jobId");

  cleanupJobs();

  if (jobId) {
    const job = jobs.get(jobId);
    if (!job) return badRequest("Export job not found.");
    if (job.status === "pending") {
      return ok({ jobId: job.id, status: job.status });
    }
    if (job.status === "failed") {
      return serverError(job.error ?? "Export failed");
    }
    if (job.format === "csv") {
      return new Response(job.csv ?? "", {
        headers: {
          "content-type": "text/csv",
          "content-disposition": `attachment; filename="${job.filename}"`,
        },
      });
    }
    return ok(job.json ?? {});
  }

  const q = (url.searchParams.get("q") ?? "").trim().toLowerCase();
  const userStatusRaw =
    url.searchParams.get("userStatus") ??
    (dataset === "users" || dataset === "all"
      ? url.searchParams.get("status")
      : null);
  const matchStatusRaw =
    url.searchParams.get("matchStatus") ??
    (dataset === "matches" ? url.searchParams.get("status") : null);
  const safetyStatusRaw =
    url.searchParams.get("safetyStatus") ??
    (dataset === "safety" ? url.searchParams.get("status") : null);
  const userStatus = userStatusRaw?.trim().toLowerCase() || undefined;
  const matchStatus = matchStatusRaw?.trim().toLowerCase() || undefined;
  const safetyStatus = safetyStatusRaw?.trim().toLowerCase() || undefined;
  const isAdmin = parseBoolean(url.searchParams.get("isAdmin"));
  const domain = url.searchParams.get("domain");
  const severity = url.searchParams.get("severity");
  const createdAfter = parseDate(
    url.searchParams.get("createdAfter") ?? url.searchParams.get("createdAt"),
  );
  const createdBefore = parseDate(url.searchParams.get("createdBefore"));
  const includeSnapshots = url.searchParams.get("includeSnapshots") === "true";
  const snapshotDaysParam =
    url.searchParams.get("snapshotDays") ?? url.searchParams.get("days");
  const snapshotDaysParsed = snapshotDaysParam
    ? Number.parseInt(snapshotDaysParam, 10)
    : 14;
  const snapshotDays = Number.isFinite(snapshotDaysParsed)
    ? clampNumber(snapshotDaysParsed, 1, 60)
    : 14;

  const filters: ExportFilters = {
    q,
    userStatus,
    matchStatus,
    safetyStatus,
    isAdmin,
    domain: domain?.trim().toLowerCase() || undefined,
    severity: severity?.trim().toLowerCase() || undefined,
    createdAfter,
    createdBefore,
    includeSnapshots,
    snapshotDays,
  };

  if (asyncMode) {
    const job = await startExportJob(dataset, format, filters);
    return ok({
      jobId: job.id,
      status: job.status,
      downloadUrl: `/api/admin/export?jobId=${job.id}`,
    });
  }

  const result = await buildExport(dataset, format, filters);
  if (format === "csv") {
    return new Response(result.csv ?? "", {
      headers: {
        "content-type": "text/csv",
        "content-disposition": `attachment; filename="${result.filename}"`,
      },
    });
  }

  return ok(result.json ?? {});
}
