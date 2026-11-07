/** Shared reminder presentation only. The canonical service owns all state and mutations. */
export interface ReminderPresentationRow {
  definition: { status: string; cadence?: { kind: string; dueAt?: string } };
  occurrence: {
    state: string;
    dueAt?: string | null;
    snoozedUntil?: string | null;
    metadata?: Record<string, unknown> | null;
  } | null;
  latestAttempt: { outcome: string } | null;
}
export function reminderDue(row: ReminderPresentationRow): string | null {
  return (
    row.occurrence?.snoozedUntil ??
    row.occurrence?.dueAt ??
    (row.definition.cadence?.kind === "once"
      ? (row.definition.cadence.dueAt ?? null)
      : null)
  );
}
export function reminderDeliveryLabel(row: ReminderPresentationRow): string {
  if (row.definition.status === "archived") return "cancelled";
  if (row.definition.status === "paused") return "paused";
  if (row.definition.status === "completed") return "completed";
  const state = row.occurrence?.state;
  if (
    state &&
    ["snoozed", "completed", "skipped", "expired", "muted"].includes(state)
  )
    return state;
  if (state && !["pending", "visible"].includes(state)) return "unknown";
  const outcome = row.latestAttempt?.outcome;
  if (outcome?.startsWith("delivered")) return "delivered";
  if (outcome?.startsWith("blocked")) return "blocked";
  if (outcome === "skipped_duplicate") return "duplicate";
  if (outcome) return "unknown";
  return row.occurrence ? "scheduled" : "unscheduled";
}
export function canSnoozeReminder(row: ReminderPresentationRow): boolean {
  return (
    row.definition.status === "active" &&
    !!row.occurrence &&
    ["pending", "visible", "snoozed"].includes(row.occurrence.state) &&
    !row.occurrence.metadata?.reminderAcknowledgedAt
  );
}
