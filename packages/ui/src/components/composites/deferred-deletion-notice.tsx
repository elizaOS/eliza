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

interface DeletionActionScope {
  bridge: DeferredDeletionsBridge;
  current(): boolean;
}

const STATUS_FAILURES_BEFORE_ERROR = 3;
/** Failed Undo or dismissal results stay visible after a refresh until the next action. */
const ACTION_FAILURES: ReadonlySet<string> = new Set([
  UNDO_TOO_LATE,
  DELETION_NOTICE_TEXT.undoUnconfirmed,
  DELETION_NOTICE_TEXT.dismissFailed,
]);
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
  const [noticeRead, setNoticeRead] = useState<{
    entries: DeferredDeletionEntry[];
    scope: DeletionActionScope;
  } | null>(null);
  const [error, setError] = useState<{
    text: string;
    scope: DeletionActionScope;
  } | null>(null);
  const [busy, setBusy] = useState<DeletionActionScope | null>(null);
  const signature = useRef("");
  const refreshRef = useRef<() => Promise<void>>(async () => {});
  // Props are read through a ref so a re-render never restarts polling or the identity epoch.
  const ports = useRef({
    bridge,
    identity,
    concealed,
    onDeletedOrigins,
    onChanged,
    noticeRead,
    error,
  });
  ports.current = {
    bridge,
    identity,
    concealed,
    onDeletedOrigins,
    onChanged,
    noticeRead,
    error,
  };
  const events = refreshEvents.join("\n");

  useEffect(() => {
    let retired = false;
    let inflight = false;
    let identityEpoch = 0;
    let failures = 0;
    const hidden = () =>
      (typeof document !== "undefined" && document.hidden) ||
      !!ports.current.concealed?.();
    // Retirement only suppresses this notice's completion; it does not cancel the native action.
    const captureScope = (): DeletionActionScope => {
      const admittedEpoch = identityEpoch;
      const admittedBridge = ports.current.bridge;
      const admittedOwner = ports.current.identity?.read() ?? "";
      return {
        bridge: admittedBridge,
        current: () =>
          !retired &&
          admittedEpoch === identityEpoch &&
          admittedBridge === ports.current.bridge &&
          admittedOwner === (ports.current.identity?.read() ?? ""),
      };
    };
    const refresh = async () => {
      if (retired) return;
      if (ports.current.noticeRead && !ports.current.noticeRead.scope.current())
        setNoticeRead((shown) => (shown?.scope.current() ? shown : null));
      if (ports.current.error && !ports.current.error.scope.current())
        setError((shown) => (shown?.scope.current() ? shown : null));
      if (inflight) return;
      if (hidden()) {
        setNoticeRead(null);
        return;
      }
      inflight = true;
      const scope = captureScope();
      const current = () => scope.current() && !hidden();
      try {
        const result = await scope.bridge.pending();
        if (!current()) return;
        if (result.deletedOrigins?.length)
          await ports.current.onDeletedOrigins?.(result.deletedOrigins);
        if (!current()) return;
        const next = deletionNoticeSignature(result.deletions);
        if (signature.current && next !== signature.current)
          ports.current.onChanged?.();
        if (!current()) return;
        signature.current = next;
        failures = 0;
        setNoticeRead({
          entries: pendingDeletionNotices(result.deletions),
          scope,
        });
        setError((shown) =>
          shown?.scope.current() && ACTION_FAILURES.has(shown.text)
            ? shown
            : null,
        );
      } catch {
        if (current() && ++failures >= STATUS_FAILURES_BEFORE_ERROR)
          setError({ text: DELETION_NOTICE_TEXT.statusUnavailable, scope });
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
      setNoticeRead(null);
      setError(null);
      setBusy(null);
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

  const entries = noticeRead?.scope.current() ? noticeRead.entries : [];
  const shownError = error?.scope.current() ? error.text : "";
  const action = noticeRead?.scope;
  if (!entries.length && !shownError) return null;
  const changed = (action?: DeletionActionScope) => {
    if (action && !action.current()) return;
    ports.current.onChanged?.();
    // A host callback may itself change the owner or bridge.
    if (!action || action.current()) void refreshRef.current();
  };
  return (
    <aside className={className} aria-label={label}>
      {shownError && <p role="status">{shownError}</p>}
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
                disabled={!!busy?.current()}
                onClick={async () => {
                  if (!action?.current()) return;
                  setBusy(action);
                  setError(null);
                  try {
                    const result = await action.bridge.undo({
                      kind: entry.kind,
                      id: entry.id,
                    });
                    if (action.current() && !undoConfirmed(result))
                      setError({ text: UNDO_TOO_LATE, scope: action });
                  } catch {
                    if (action.current())
                      setError({
                        text: DELETION_NOTICE_TEXT.undoUnconfirmed,
                        scope: action,
                      });
                  } finally {
                    if (action.current()) {
                      setBusy(null);
                      changed(action);
                    }
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
                  disabled={!!busy?.current()}
                  onClick={() => {
                    if (!action?.current()) return;
                    setError({
                      text: DELETION_NOTICE_TEXT.refreshing,
                      scope: action,
                    });
                    changed(action);
                  }}
                >
                  Refresh receipt
                </button>
                <button
                  type="button"
                  disabled={!!busy?.current()}
                  onClick={async () => {
                    if (!action?.current()) return;
                    setBusy(action);
                    setError(null);
                    try {
                      await action.bridge.dismiss({
                        kind: entry.kind,
                        id: entry.id,
                      });
                      if (!action.current()) return;
                      setNoticeRead((shown) =>
                        action.current() && shown?.scope.current()
                          ? {
                              ...shown,
                              entries: shown.entries.filter(
                                (row) =>
                                  row.id !== entry.id ||
                                  row.kind !== entry.kind,
                              ),
                            }
                          : shown,
                      );
                      setError({
                        text: DELETION_NOTICE_TEXT.dismissed,
                        scope: action,
                      });
                      changed(action);
                    } catch {
                      if (action.current())
                        setError({
                          text: DELETION_NOTICE_TEXT.dismissFailed,
                          scope: action,
                        });
                    } finally {
                      if (action.current()) setBusy(null);
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
