/**
 * The pending-deletion Undo notice for reviewed, delayed deletions (Calendar events,
 * reminders and other device records). Rules live in `@elizaos/contracts/deletion-window`:
 * Undo is offered only while the window is open or paused, Undo is confirmed only by an
 * `undone` receipt, and an uncertain outcome can be refreshed or dismissed but never replayed.
 *
 * The host supplies its bridge, an owner/session identity (a change clears every row), a
 * concealment check (hidden document, locked screen) and a change callback that refreshes the
 * record views. The notice shows no rows while concealed.
 */
import {
  DELETION_NOTICE_TEXT,
  type DeferredDeletionEntry,
  type DeferredDeletionsBridge,
  type DeletedRecordOrigin,
  deletionNotice,
  deletionNoticeSignature,
  pendingDeletionNotices,
  UNDO_TOO_LATE,
  undoConfirmed,
} from "@elizaos/contracts/deletion-window";
import { useEffect, useRef, useState } from "react";

export interface DeferredDeletionIdentity {
  /** A stable key for the current owner/session; an empty string means none. */
  read(): string;
  subscribe(listener: () => void): () => void;
}

export interface DeferredDeletionNoticeProps {
  bridge: DeferredDeletionsBridge;
  identity?: DeferredDeletionIdentity;
  /** True while rows must not be shown or read (for example a locked screen). */
  concealed?: () => boolean;
  /** Forget saved origins of deleted records before the list is shown. */
  onDeletedOrigins?: (
    origins: readonly DeletedRecordOrigin[],
  ) => Promise<void> | void;
  /** Record views must re-read: the notice list changed, or an Undo/dismissal settled. */
  onChanged?: () => void;
  /** Window events that request an immediate refresh. */
  refreshEvents?: readonly string[];
  /** Poll interval while mounted. */
  pollMs?: number;
  className?: string;
  label?: string;
}

const STATUS_FAILURES_BEFORE_ERROR = 3;
/** Neutral default placement; hosts with their own theme pass `className`. */
const DEFAULT_CLASS =
  "fixed inset-x-3 bottom-24 z-50 max-h-[30vh] overflow-auto rounded-md border border-border bg-card px-3 py-2 text-txt shadow-lg [&>div]:flex [&>div]:items-center [&>div]:gap-3 [&_p]:flex-1 [&_p]:break-words [&_button]:min-h-12 [&_button]:min-w-16";

export function DeferredDeletionNotice({
  bridge,
  identity,
  concealed,
  onDeletedOrigins,
  onChanged,
  refreshEvents = [],
  pollMs = 500,
  className = DEFAULT_CLASS,
  label = "Pending deletions",
}: DeferredDeletionNoticeProps) {
  const [entries, setEntries] = useState<DeferredDeletionEntry[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const signature = useRef("");
  const refreshRef = useRef<() => Promise<void>>(async () => {});
  // Props are read through a ref so a re-render never restarts polling or the identity epoch.
  const ports = useRef({
    bridge,
    identity,
    concealed,
    onDeletedOrigins,
    onChanged,
  });
  ports.current = { bridge, identity, concealed, onDeletedOrigins, onChanged };
  const events = refreshEvents.join("\n");

  useEffect(() => {
    let retired = false;
    let inflight = false;
    let identityEpoch = 0;
    let failures = 0;
    const hidden = () =>
      (typeof document !== "undefined" && document.hidden) ||
      !!ports.current.concealed?.();
    const refresh = async () => {
      if (inflight || retired) return;
      if (hidden()) {
        setEntries([]);
        return;
      }
      inflight = true;
      const admittedEpoch = identityEpoch;
      const current = () =>
        !retired && admittedEpoch === identityEpoch && !hidden();
      try {
        const result = await ports.current.bridge.pending();
        if (!current()) return;
        if (result.deletedOrigins?.length)
          await ports.current.onDeletedOrigins?.(result.deletedOrigins);
        if (!current()) return;
        const next = deletionNoticeSignature(result.deletions);
        if (signature.current && next !== signature.current)
          ports.current.onChanged?.();
        signature.current = next;
        failures = 0;
        setEntries(pendingDeletionNotices(result.deletions));
        setError("");
      } catch {
        if (current() && ++failures >= STATUS_FAILURES_BEFORE_ERROR)
          setError(DELETION_NOTICE_TEXT.statusUnavailable);
      } finally {
        inflight = false;
      }
    };
    refreshRef.current = refresh;
    const listener = () => void refresh();
    let previousIdentity = ports.current.identity?.read() ?? "";
    const unsubscribe = ports.current.identity?.subscribe(() => {
      const next = ports.current.identity?.read() ?? "";
      if (next === previousIdentity) return;
      previousIdentity = next;
      identityEpoch++;
      failures = 0;
      signature.current = "";
      setEntries([]);
      setError("");
      void refresh();
    });
    void refresh();
    const timer = setInterval(listener, pollMs);
    const names = events ? events.split("\n") : [];
    for (const name of names) window.addEventListener(name, listener);
    document.addEventListener("visibilitychange", listener);
    return () => {
      retired = true;
      unsubscribe?.();
      clearInterval(timer);
      for (const name of names) window.removeEventListener(name, listener);
      document.removeEventListener("visibilitychange", listener);
    };
  }, [events, pollMs]);

  if (!entries.length && !error) return null;
  const changed = () => {
    ports.current.onChanged?.();
    void refreshRef.current();
  };
  return (
    <aside className={className} aria-label={label}>
      {error && <p role="status">{error}</p>}
      {entries.map((entry) => {
        const notice = deletionNotice(entry);
        return (
          <div key={notice.key}>
            <p>
              {notice.title}
              <br />
              <small>{notice.message}</small>
            </p>
            {notice.canUndo && (
              <button
                type="button"
                disabled={!!busy}
                onClick={async () => {
                  setBusy(entry.id);
                  try {
                    const result = await ports.current.bridge.undo({
                      kind: entry.kind,
                      id: entry.id,
                    });
                    if (!undoConfirmed(result)) setError(UNDO_TOO_LATE);
                  } catch {
                    setError(DELETION_NOTICE_TEXT.undoUnconfirmed);
                  } finally {
                    setBusy("");
                    changed();
                  }
                }}
              >
                Undo
              </button>
            )}
            {notice.uncertain && (
              <>
                <button
                  type="button"
                  disabled={!!busy}
                  onClick={() => {
                    setError(DELETION_NOTICE_TEXT.refreshing);
                    changed();
                  }}
                >
                  Refresh receipt
                </button>
                <button
                  type="button"
                  disabled={!!busy}
                  onClick={async () => {
                    setBusy(entry.id);
                    try {
                      await ports.current.bridge.dismiss({
                        kind: entry.kind,
                        id: entry.id,
                      });
                      setEntries((rows) =>
                        rows.filter(
                          (row) =>
                            row.id !== entry.id || row.kind !== entry.kind,
                        ),
                      );
                      setError(DELETION_NOTICE_TEXT.dismissed);
                      changed();
                    } catch {
                      setError(DELETION_NOTICE_TEXT.dismissFailed);
                    } finally {
                      setBusy("");
                    }
                  }}
                >
                  Dismiss outcome
                </button>
              </>
            )}
          </div>
        );
      })}
    </aside>
  );
}
