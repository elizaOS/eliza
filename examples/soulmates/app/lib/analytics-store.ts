import { desc, eq } from "drizzle-orm";
import type { AnalyticsSummary } from "@/lib/analytics-types";
import { analyticsSnapshotTable, getDatabase } from "@/lib/db";

export type AnalyticsSnapshot = {
  day: string;
  summary: AnalyticsSummary;
  createdAt: string;
};

export async function upsertAnalyticsSnapshot(
  day: string,
  summary: AnalyticsSummary,
): Promise<void> {
  const db = await getDatabase();
  await db
    .insert(analyticsSnapshotTable)
    .values({
      day,
      snapshot: summary,
      createdAt: new Date(),
    })
    .onConflictDoUpdate({
      target: analyticsSnapshotTable.day,
      set: {
        snapshot: summary,
        createdAt: new Date(),
      },
    });
}

export async function getAnalyticsSnapshot(
  day: string,
): Promise<AnalyticsSnapshot | null> {
  const db = await getDatabase();
  const [row] = await db
    .select()
    .from(analyticsSnapshotTable)
    .where(eq(analyticsSnapshotTable.day, day))
    .limit(1);
  if (!row) return null;
  return {
    day: row.day,
    summary: row.snapshot,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function listAnalyticsSnapshots(
  days: number,
): Promise<AnalyticsSnapshot[]> {
  const db = await getDatabase();
  const rows = await db
    .select()
    .from(analyticsSnapshotTable)
    .orderBy(desc(analyticsSnapshotTable.day))
    .limit(days);
  return rows.map((row) => ({
    day: row.day,
    summary: row.snapshot,
    createdAt: row.createdAt.toISOString(),
  }));
}
