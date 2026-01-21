import { NextResponse } from "next/server";
import { getDatabase, usersTable } from "@/lib/db";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const VERSION = "2.0.0"; // Update on release
const DB_TIMEOUT_MS = 5000;

type HealthStatus = {
  status: "healthy" | "degraded" | "unhealthy";
  timestamp: string;
  version: string;
  checks: {
    database: { status: "up" | "down"; latencyMs?: number; error?: string };
  };
};

async function checkDatabaseWithTimeout(): Promise<{
  ok: boolean;
  latencyMs: number;
  error?: string;
}> {
  const start = Date.now();
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(
      () =>
        reject(new Error(`Database query timed out after ${DB_TIMEOUT_MS}ms`)),
      DB_TIMEOUT_MS,
    );
  });

  try {
    const db = await getDatabase();
    await Promise.race([db.select().from(usersTable).limit(1), timeoutPromise]);
    return { ok: true, latencyMs: Date.now() - start };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, latencyMs: Date.now() - start, error: message };
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

export async function GET(): Promise<NextResponse<HealthStatus>> {
  const timestamp = new Date().toISOString();
  const dbCheck = await checkDatabaseWithTimeout();

  const dbStatus: HealthStatus["checks"]["database"] = dbCheck.ok
    ? { status: "up", latencyMs: dbCheck.latencyMs }
    : { status: "down", latencyMs: dbCheck.latencyMs, error: dbCheck.error };

  if (!dbCheck.ok) {
    logger.error("Health check: database down", {
      error: dbCheck.error,
      latencyMs: dbCheck.latencyMs,
    });
  }

  const overallStatus: HealthStatus["status"] =
    dbStatus.status === "up" ? "healthy" : "unhealthy";

  const response: HealthStatus = {
    status: overallStatus,
    timestamp,
    version: VERSION,
    checks: { database: dbStatus },
  };

  return NextResponse.json(response, {
    status: overallStatus === "healthy" ? 200 : 503,
  });
}
