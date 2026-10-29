/**
 * Browser-safe contract for the reviewed deletion Undo window shared by Calendar,
 * reminders and any other device record whose deletion is delayed after review.
 *
 * - A reviewed deletion is staged for ten seconds before the provider write.
 * - Expiry is measured on a monotonic clock bound to one continuity (boot, renderer);
 *   wall time is display metadata only, never expiry authority.
 * - A lost clock continuity never authorizes the write: the row pauses for review, and
 *   cancelling a still-unapplied intent stays safe.
 * - Undo and expiry have exactly one winner, decided while holding the durable store
 *   transaction. A dispatching or unknown outcome is never replayed.
 * - Undo is confirmed only by a receipt whose phase is `undone`. A settled deletion is never
 *   reported as kept, and a recreated item (for example an invitation re-sent by a provider)
 *   is not a lossless restore, so this window never offers one.
 *
 * Native hosts implement the same rules in `@elizaos/capacitor-action-journal`
 * (`ai.eliza.plugins.actionjournal.deletion`). Nothing here performs a deletion.
 */

/** The Undo window. Native `DeletionDeadline.WINDOW_MS` must equal this. */
export const DELETE_UNDO_MS = 10_000;

export interface DeletionClock {
  /** Names one uninterrupted monotonic clock (a boot, a renderer lifetime). */
  continuity: string;
  /** Monotonic milliseconds on that clock. */
  elapsed: number;
  /** Wall-clock milliseconds; display only. */
  wall: number;
}

export interface DeletionDeadline {
  continuity: string;
  createdElapsed: number;
  expiresElapsed: number;
  /** Wall-clock display hint. Never compared for expiry. */
  expiresAt: number;
}

export type DeletionPhase =
  | "queued"
  | "paused"
  | "dispatching"
  | "undone"
  | "deleted"
  | "conflict"
  | "permission-required"
  | "owner-changed"
  | "unknown";

export type DeletionWindowState = "open" | "expired" | "clock-changed";

export interface PendingDeletion<T> {
  version: 1;
  id: string;
  owner: string;
  target: T;
  deadline: DeletionDeadline;
  phase: DeletionPhase;
  acknowledged?: boolean;
}

function clockValid(clock: DeletionClock | null | undefined): boolean {
  return (
    !!clock &&
    typeof clock.continuity === "string" &&
    clock.continuity.length > 0 &&
    clock.continuity.length <= 200 &&
    Number.isFinite(clock.elapsed) &&
    clock.elapsed >= 0 &&
    Number.isSafeInteger(clock.wall) &&
    clock.wall >= 0
  );
}

export function deletionDeadline(clock: DeletionClock): DeletionDeadline {
  if (
    !clockValid(clock) ||
    clock.wall > Number.MAX_SAFE_INTEGER - DELETE_UNDO_MS
  )
    throw new Error("Deletion clock unavailable");
  return {
    continuity: clock.continuity,
    createdElapsed: clock.elapsed,
    expiresElapsed: clock.elapsed + DELETE_UNDO_MS,
    expiresAt: clock.wall + DELETE_UNDO_MS,
  };
}

export function deletionWindow(
  deadline: DeletionDeadline,
  clock: DeletionClock,
): DeletionWindowState {
  if (
    !clockValid(clock) ||
    !deadline ||
    clock.continuity !== deadline.continuity ||
    !Number.isFinite(deadline.createdElapsed) ||
    deadline.createdElapsed < 0 ||
    deadline.expiresElapsed !== deadline.createdElapsed + DELETE_UNDO_MS ||
    !Number.isSafeInteger(deadline.expiresAt) ||
    clock.elapsed < deadline.createdElapsed
  )
    return "clock-changed";
  return clock.elapsed < deadline.expiresElapsed ? "open" : "expired";
}

/**
 * Apply while holding the durable document transaction: Undo and expiry have one winner.
 * Mutates `entry.phase` and returns true only for the winning claim.
 */
export function claimDeletion<T>(
  entry: PendingDeletion<T>,
  owner: string,
  clock: DeletionClock,
  action: "undo" | "dispatch",
): boolean {
  if (
    (entry.phase !== "queued" &&
      !(action === "undo" && entry.phase === "paused")) ||
    entry.owner !== owner
  )
    return false;
  const state = deletionWindow(entry.deadline, clock);
  // Lost clock continuity never authorizes a write. Cancelling a still-unapplied intent is safe.
  if (action === "undo") {
    if (entry.phase !== "paused" && state === "expired") return false;
    entry.phase = "undone";
    return true;
  }
  if (state !== "expired") return false;
  entry.phase = "dispatching";
  return true;
}

let rendererContinuity: string | undefined;
/**
 * A renderer-lifetime clock. A new renderer cannot prove continuity of an OS clock while it
 * was absent, so its rows read as `clock-changed` and need review again.
 */
export function rendererDeletionClock(): DeletionClock {
  rendererContinuity ??= globalThis.crypto.randomUUID();
  return {
    continuity: rendererContinuity,
    elapsed: globalThis.performance.now(),
    wall: Date.now(),
  };
}

export const UNDO_TOO_LATE =
  "Undo was too late. The deletion already went ahead; check the item before relying on it.";

/** Undo is confirmed only by a receipt whose phase is 'undone'; a settled deletion is never shown as kept. */
export function undoConfirmed(result: unknown): boolean {
  return (
    !!result &&
    typeof result === "object" &&
    (result as { phase?: unknown }).phase === "undone"
  );
}

// ---- Pending-deletion bridge and notice ----

/** One row a host's pending-deletion bridge reports. */
export interface DeferredDeletionEntry {
  id: string;
  /** Host record kind, e.g. `calendar` or `reminder`. */
  kind: string;
  phase: string;
  window?: DeletionWindowState | string;
  expiresAt?: number;
  deadline?: { expiresAt: number };
  target: { row?: { title?: string }; fields?: { title?: string } };
  original?: { title?: string };
}

/** A deleted record that linked a saved origin (for example a Note) the host should forget. */
export interface DeletedRecordOrigin {
  kind: "event" | "reminder";
  id: string;
}

export interface DeferredDeletionsPending {
  deletions: DeferredDeletionEntry[];
  deletedOrigins?: DeletedRecordOrigin[];
}

export interface DeferredDeletionKey {
  kind: string;
  id: string;
}

/**
 * The host bridge behind the Undo notice. Hosts register it under their installed plugin
 * name; the renderer supplies a selected revision only, never owner authority.
 */
export interface DeferredDeletionsBridge {
  pending(): Promise<DeferredDeletionsPending>;
  /** Only an uncertain (`unknown`/`dispatching`) outcome may be dismissed; its receipt is kept. */
  dismiss(input: DeferredDeletionKey): Promise<unknown>;
  undo(input: DeferredDeletionKey): Promise<unknown>;
}

/** Phases the Undo notice shows. Terminal receipts are history, not notices. */
export const DELETION_NOTICE_PHASES: ReadonlySet<string> = new Set([
  "queued",
  "paused",
  "unknown",
  "dispatching",
]);

export const DELETION_NOTICE_TEXT = {
  paused:
    "Deletion paused. Undo to keep it, then review again if you still want to delete.",
  queued: "Deletion queued for 10 seconds.",
  uncertain: "Deletion outcome needs review. It will not be repeated.",
  verifying: "Deletion is being verified.",
  statusUnavailable:
    "Pending deletion status is unavailable. Refresh before making another change.",
  undoUnconfirmed:
    "Undo could not be confirmed. The deletion may already have gone ahead; refresh and inspect the saved item.",
  refreshing:
    "Refreshing the saved receipt. This does not repeat the deletion or prove the item was restored.",
  dismissed:
    "Outcome dismissed. The receipt is retained; nothing was restored or repeated.",
  dismissFailed:
    "The outcome could not be dismissed. Refresh the receipt and try again.",
} as const;

export interface DeletionNotice {
  key: string;
  title: string;
  message: string;
  canUndo: boolean;
  /** Dispatch may have happened: offer receipt refresh and dismissal, never a replay. */
  uncertain: boolean;
}

/** Presentation of one pending row. Undo is offered while the window is open or paused. */
export function deletionNotice(entry: DeferredDeletionEntry): DeletionNotice {
  const uncertain = entry.phase === "unknown" || entry.phase === "dispatching";
  const paused = entry.phase === "paused" || entry.window === "clock-changed";
  const canUndo =
    paused || (entry.phase === "queued" && entry.window === "open");
  return {
    key: `${entry.kind}:${entry.id}`,
    title:
      entry.target.row?.title ||
      entry.target.fields?.title ||
      entry.original?.title ||
      `Selected ${entry.kind}`,
    message: paused
      ? DELETION_NOTICE_TEXT.paused
      : canUndo
        ? DELETION_NOTICE_TEXT.queued
        : uncertain
          ? DELETION_NOTICE_TEXT.uncertain
          : DELETION_NOTICE_TEXT.verifying,
    canUndo,
    uncertain,
  };
}

/** Rows the notice shows, in bridge order. */
export function pendingDeletionNotices(
  entries: readonly DeferredDeletionEntry[],
): DeferredDeletionEntry[] {
  return entries.filter((entry) => DELETION_NOTICE_PHASES.has(entry.phase));
}

/** Identity of the notice list; a change means the record views must refresh. */
export function deletionNoticeSignature(
  entries: readonly DeferredDeletionEntry[],
): string {
  return entries
    .map((entry) => [entry.kind, entry.id, entry.phase].join(","))
    .join("|");
}

/**
 * Review statuses that prove nothing was claimed or staged, with the message shown for each.
 * `unknown` is not listed: it remains an uncertain outcome.
 */
export function deletionReviewRefusal(status: string): string | undefined {
  switch (status) {
    case "stale":
      return "This item changed. Review it again before deleting.";
    case "unavailable":
      return "Deletion review is unavailable. Open the item and try again; nothing changed.";
    case "not-staged":
      return "Deletion was not queued. Nothing changed; review it again if you still want to delete it.";
    default:
      return undefined;
  }
}

/** The reminder wording of {@link deletionReviewRefusal}. */
export function reminderDeletionRefusal(status: string): string | undefined {
  switch (status) {
    case "stale":
      return "This reminder changed. Review it again before deleting.";
    case "unavailable":
      return "Deletion review is unavailable. Open the reminder and try again; nothing changed.";
    default:
      return deletionReviewRefusal(status);
  }
}
