/** Bounded retention observations; never completion proof or deletion authority. */
import { createHash } from "node:crypto";
import type { privatePitrApi } from "./pitr-private-api";

const hash = (s: string) => createHash("sha256").update(s).digest("hex");
function object(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}
function date(v: unknown): string | null {
  if (typeof v !== "string" || v.length > 40) return null;
  const n = Date.parse(v);
  return Number.isFinite(n) ? new Date(n).toISOString() : null;
}
function size(v: unknown): number | null {
  return typeof v === "number" &&
    Number.isInteger(v) &&
    v >= 0 &&
    v <= 2147483647
    ? v
    : null;
}
export function backupRetentionInventory(
  entries: unknown[],
  observedAt: number,
) {
  const rows = entries.map(object);
  if (rows.length > 15)
    return {
      available: false,
      reason: "inventory_bound_exceeded",
      listedCount: rows.length,
      deletionAuthorized: false,
    };
  const ids = rows.map((r) => r.id);
  if (
    ids.some(
      (id) => typeof id !== "string" || id.length === 0 || id.length > 256,
    ) ||
    new Set(ids).size !== ids.length
  )
    return {
      available: false,
      reason: "inventory_identity_invalid",
      listedCount: rows.length,
      deletionAuthorized: false,
    };
  const backups = rows
    .map((r) => {
      const createdAt = date(r.createdAt),
        expiresAt = date(r.expiresAt);
      return {
        backupReceipt: hash(r.id as string),
        createdAt,
        expiresAt,
        noScheduledExpiry: r.expiresAt === null,
        expiryState:
          r.expiresAt === null
            ? "no_scheduled_expiry"
            : expiresAt === null
              ? "unknown"
              : Date.parse(expiresAt) <= observedAt
                ? "expired"
                : "retained",
        classification:
          r.scheduleId === null
            ? "manual"
            : typeof r.scheduleId === "string" && r.scheduleId.length > 0
              ? "scheduled"
              : "unknown",
        usedMB: size(r.usedMB),
        referencedMB: size(r.referencedMB),
        volumeCapacityMB: size(r.volumeInstanceSizeMB),
        createdInFuture:
          createdAt === null ? null : Date.parse(createdAt) > observedAt,
      };
    })
    .sort(
      (a, b) =>
        (b.createdAt ?? "").localeCompare(a.createdAt ?? "") ||
        a.backupReceipt.localeCompare(b.backupReceipt),
    );
  const valid = backups.filter((b) => b.createdAt && !b.createdInFuture);
  const newest = valid[0]?.createdAt;
  return {
    available: true,
    observedAt: new Date(observedAt).toISOString(),
    listedCount: rows.length,
    backups: backups.map((b) => ({
      ...b,
      preserveAsMostRecent: !!newest && b.createdAt === newest,
    })),
    completionEvidence: "unavailable_from_backup_list",
    deletionAuthorized: false,
    restoreProven: false,
  };
}
export async function observeBackupSchedules(
  api: typeof privatePitrApi,
  id: string,
  signal?: AbortSignal,
) {
  try {
    const response = object(await api("backupSchedules", { id }, signal));
    const rows = object(response.data).volumeInstanceBackupScheduleList;
    if (!Array.isArray(rows) || rows.length > 3) throw Error("shape");
    const schedules = rows.map((value) => {
      const r = object(value);
      if (!["DAILY", "WEEKLY", "MONTHLY"].includes(r.kind as string))
        throw Error("kind");
      return {
        kind: r.kind as string,
        createdAt: date(r.createdAt),
        retentionSeconds: size(r.retentionSeconds),
      };
    });
    if (new Set(schedules.map((r) => r.kind)).size !== schedules.length)
      throw Error("duplicate");
    return { available: true, schedules };
  } catch {
    return { available: false, reason: "schedule_observation_unavailable" };
  }
}
