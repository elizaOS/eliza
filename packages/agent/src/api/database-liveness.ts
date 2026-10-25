/**
 * Database liveness probing for process health endpoints. The probe performs a
 * real `SELECT 1` round trip against the active adapter instead of trusting
 * cached adapter state, so a closed embedded PGlite instance cannot report as
 * healthy while every real operation is failing.
 */
import type { AgentRuntime } from "@elizaos/core";
import { sql } from "drizzle-orm";

export type DatabaseLivenessStatus =
  | "ok"
  | "unknown"
  | "transient_error"
  | "terminal_error";

export interface DatabaseLivenessProbeResult {
  status: DatabaseLivenessStatus;
  ok: boolean;
  terminal: boolean;
  message?: string;
}

interface RawQueryable {
  query(sql: string): Promise<unknown>;
}

interface DrizzleExecutable {
  execute(query: unknown): Promise<unknown>;
}

interface LivenessAdapter {
  isReady?: () => Promise<boolean>;
  getRawConnection?: () => RawQueryable;
  getConnection?: () => Promise<unknown>;
  db?: unknown;
}

const TERMINAL_PGLITE_PATTERNS = [
  /pglite is closed/i,
  /database is shutting down/i,
  /operation rejected/i,
  /cannot query.*closed/i,
  /closed database/i,
] as const;

function describeProbeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    // error-policy:J3 diagnostic formatting fallback for non-serializable input
    return String(error);
  }
}

export function isTerminalDatabaseLivenessError(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && !seen.has(current)) {
    seen.add(current);
    const message =
      current instanceof Error
        ? current.message
        : typeof current === "string"
          ? current
          : "";
    if (TERMINAL_PGLITE_PATTERNS.some((pattern) => pattern.test(message))) {
      return true;
    }
    current =
      current instanceof Error
        ? (current as Error & { cause?: unknown }).cause
        : typeof current === "object" && current !== null && "cause" in current
          ? (current as { cause?: unknown }).cause
          : null;
  }
  return false;
}

function asAdapter(runtime: AgentRuntime): LivenessAdapter | null {
  const adapter = runtime.adapter;
  if (!adapter || typeof adapter !== "object") return null;
  return adapter as LivenessAdapter;
}

async function probeHandle(handle: unknown): Promise<void> {
  if (handle && typeof handle === "object") {
    const raw = handle as Partial<RawQueryable>;
    if (typeof raw.query === "function") {
      await raw.query("SELECT 1");
      return;
    }
    const executable = handle as Partial<DrizzleExecutable>;
    if (typeof executable.execute === "function") {
      await executable.execute(sql`SELECT 1`);
      return;
    }
  }
  throw new Error("database connection does not expose query or execute");
}

async function runProbe(adapter: LivenessAdapter): Promise<void> {
  if (typeof adapter.getRawConnection === "function") {
    await probeHandle(adapter.getRawConnection());
    return;
  }
  if (typeof adapter.getConnection === "function") {
    await probeHandle(await adapter.getConnection());
    return;
  }
  if (adapter.db) {
    await probeHandle(adapter.db);
    return;
  }
  if (typeof adapter.isReady === "function") {
    const ready = await adapter.isReady();
    if (ready) return;
    throw new Error("adapter.isReady() returned false");
  }
  throw new Error("database adapter exposes no liveness probe surface");
}

export async function probeRuntimeDatabaseLiveness(
  runtime: AgentRuntime | null,
): Promise<DatabaseLivenessProbeResult> {
  if (!runtime) {
    return { status: "unknown", ok: false, terminal: false };
  }
  const adapter = asAdapter(runtime);
  if (!adapter) {
    return { status: "unknown", ok: true, terminal: false };
  }
  try {
    await runProbe(adapter);
    return { status: "ok", ok: true, terminal: false };
  } catch (error) {
    // error-policy:J4 health probe translates database failure into liveness state
    const terminal = isTerminalDatabaseLivenessError(error);
    return {
      status: terminal ? "terminal_error" : "transient_error",
      ok: false,
      terminal,
      message: describeProbeError(error),
    };
  }
}
