import { listAnalyticsSnapshots } from "@/lib/analytics-store";
import { ok, unauthorized } from "@/lib/api-utils";
import { requireAdminUser } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULT_DAYS = 14;
const MAX_DAYS = 60;

export async function GET(request: Request) {
  const admin = await requireAdminUser();
  if (!admin) return unauthorized();

  const url = new URL(request.url);
  const daysParam = url.searchParams.get("days");
  const parsed = daysParam ? Number.parseInt(daysParam, 10) : DEFAULT_DAYS;
  const days = Number.isFinite(parsed)
    ? Math.min(Math.max(parsed, 1), MAX_DAYS)
    : DEFAULT_DAYS;

  const snapshots = await listAnalyticsSnapshots(days);
  return ok(snapshots);
}
