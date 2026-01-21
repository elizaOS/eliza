import type { SafetyReport } from "@engine/types";
import { badRequest, notFound, ok, unauthorized } from "@/lib/api-utils";
import {
  getUserByPersonaId,
  loadEngineState,
  saveEngineState,
} from "@/lib/engine-store";
import { requireAdminUser } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export type SafetyReportSummary = {
  reportId: string;
  severity: SafetyReport["severity"];
  status: SafetyReport["status"];
  createdAt: string;
  reporter: { personaId: number; name: string; phone: string | null };
  target: { personaId: number; name: string; phone: string | null };
  notes: string;
  transcriptRef?: string;
};

type SafetyUpdateRequest = {
  reportId?: string;
  status?: SafetyReport["status"];
};

type SafetyReportPage = {
  items: SafetyReportSummary[];
  total: number;
  nextCursor: { createdAt: string; id: string } | null;
};

const clamp = (value: number, min: number, max: number): number =>
  Math.min(Math.max(value, min), max);

const parseCursor = (
  value: string | null,
): { createdAt: string; id: string } | null => {
  if (!value) return null;
  const [createdAt, id] = value.split("|");
  if (!createdAt || !id) return null;
  const date = new Date(createdAt);
  if (!Number.isFinite(date.getTime())) return null;
  return { createdAt: date.toISOString(), id };
};

const buildSummary = async (
  report: SafetyReport,
): Promise<SafetyReportSummary> => {
  const reporter = await getUserByPersonaId(report.reporterId);
  const target = await getUserByPersonaId(report.targetId);
  return {
    reportId: report.reportId,
    severity: report.severity,
    status: report.status,
    createdAt: report.createdAt,
    reporter: {
      personaId: report.reporterId,
      name: reporter?.name ?? "Unknown",
      phone: reporter?.phone ?? null,
    },
    target: {
      personaId: report.targetId,
      name: target?.name ?? "Unknown",
      phone: target?.phone ?? null,
    },
    notes: report.notes,
    transcriptRef: report.transcriptRef,
  };
};

export async function GET(request: Request) {
  const admin = await requireAdminUser();
  if (!admin) return unauthorized();

  const url = new URL(request.url);
  const q = url.searchParams.get("q")?.trim().toLowerCase() || "";
  const statusFilter = url.searchParams.get("status");
  const severityFilter = url.searchParams.get("severity");
  const createdAfter =
    url.searchParams.get("createdAfter") ?? url.searchParams.get("createdAt");
  const createdBefore = url.searchParams.get("createdBefore");
  const limitParam = url.searchParams.get("limit");
  const limit = clamp(Number.parseInt(limitParam ?? "50", 10), 1, 200);
  const cursor = parseCursor(url.searchParams.get("cursor"));
  const createdAfterTime = createdAfter ? Date.parse(createdAfter) : null;
  const createdBeforeTime = createdBefore ? Date.parse(createdBefore) : null;

  const record = await loadEngineState();
  const summaries = await Promise.all(
    record.state.safetyReports.map(buildSummary),
  );

  const filtered = summaries.filter((summary) => {
    if (statusFilter && summary.status !== statusFilter) return false;
    if (severityFilter && summary.severity !== severityFilter) return false;
    if (createdAfterTime !== null && Number.isFinite(createdAfterTime)) {
      if (Date.parse(summary.createdAt) < createdAfterTime) return false;
    }
    if (createdBeforeTime !== null && Number.isFinite(createdBeforeTime)) {
      if (Date.parse(summary.createdAt) >= createdBeforeTime) return false;
    }
    if (q) {
      const haystack = [
        summary.reportId,
        summary.notes,
        summary.reporter.name,
        summary.reporter.phone ?? "",
        summary.target.name,
        summary.target.phone ?? "",
        summary.transcriptRef ?? "",
      ]
        .join(" ")
        .toLowerCase();
      if (!haystack.includes(q)) return false;
    }
    return true;
  });

  const sorted = filtered.sort((a, b) => {
    const timeDiff = Date.parse(b.createdAt) - Date.parse(a.createdAt);
    if (timeDiff !== 0) return timeDiff;
    return a.reportId < b.reportId ? 1 : -1;
  });

  const cursorTime = cursor ? Date.parse(cursor.createdAt) : null;
  const windowed = sorted.filter((item) => {
    if (!cursor || cursorTime === null || !Number.isFinite(cursorTime))
      return true;
    const itemTime = Date.parse(item.createdAt);
    if (itemTime < cursorTime) return true;
    if (itemTime === cursorTime && item.reportId < cursor.id) return true;
    return false;
  });

  const items = windowed.slice(0, limit);
  const last = items[items.length - 1];
  const nextCursor =
    items.length === limit && last
      ? { createdAt: last.createdAt, id: last.reportId }
      : null;

  const payload: SafetyReportPage = {
    items,
    total: filtered.length,
    nextCursor,
  };

  return ok(payload);
}

export async function PATCH(request: Request) {
  const admin = await requireAdminUser();
  if (!admin) return unauthorized();

  const body = (await request.json()) as SafetyUpdateRequest | null;
  if (!body || !body.reportId || !body.status) {
    return badRequest("Missing reportId or status.");
  }

  const record = await loadEngineState();
  const report = record.state.safetyReports.find(
    (entry) => entry.reportId === body.reportId,
  );
  if (!report) {
    return notFound("Safety report not found.");
  }

  if (
    body.status !== "open" &&
    body.status !== "reviewing" &&
    body.status !== "resolved"
  ) {
    return badRequest("Invalid status.");
  }

  report.status = body.status;
  await saveEngineState({
    state: record.state,
    cursor: record.cursor,
    lastRunAt: new Date(),
    lastRunDurationMs: null,
    lockedUntil: null,
  });

  return ok(await buildSummary(report));
}
