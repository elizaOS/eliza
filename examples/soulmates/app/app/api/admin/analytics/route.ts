import { computeAnalytics } from "@/lib/analytics";
import { upsertAnalyticsSnapshot } from "@/lib/analytics-store";
import { ok, unauthorized } from "@/lib/api-utils";
import { loadEngineState } from "@/lib/engine-store";
import { requireAdminUser } from "@/lib/session";
import { listUsers } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type AnalyticsCache = {
  value: Awaited<ReturnType<typeof computeAnalytics>>;
  expiresAt: number;
};

const CACHE_TTL_MS = 60_000;
let cachedAnalytics: AnalyticsCache | null = null;

export async function GET() {
  const admin = await requireAdminUser();
  if (!admin) return unauthorized();

  const now = Date.now();
  if (cachedAnalytics && cachedAnalytics.expiresAt > now) {
    return ok(cachedAnalytics.value);
  }

  const [users, record] = await Promise.all([listUsers(), loadEngineState()]);
  const analytics = computeAnalytics(users, record.state);
  cachedAnalytics = { value: analytics, expiresAt: now + CACHE_TTL_MS };
  const day = new Date().toISOString().slice(0, 10);
  await upsertAnalyticsSnapshot(day, analytics);
  return ok(analytics);
}
