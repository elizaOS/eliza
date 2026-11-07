/**
 * When to run Notes Trash maintenance so expiry never waits for the user to open Notes:
 * whenever the app returns to the foreground and on a fixed interval while it is alive.
 * Hosts supply the visibility source, an optional native resume signal and the interval.
 */
export interface NotesTrashVisibility {
  readonly hidden: boolean;
  addEventListener(type: "visibilitychange", listener: () => void): void;
  removeEventListener(type: "visibilitychange", listener: () => void): void;
}
export interface NotesTrashScheduleHost {
  /** Start one maintenance pass. The host deduplicates concurrent passes. */
  run(): void;
  intervalMs: number;
  visibility?: NotesTrashVisibility;
  /** Native "app resumed" signal; returns its unsubscribe function. */
  onResume?(listener: () => void): () => void;
  setInterval?(handler: () => void, ms: number): unknown;
  clearInterval?(handle: unknown): void;
}

/** Returns a function that stops every trigger. Hidden documents never start a pass. */
export function scheduleNotesTrashMaintenance(
  host: NotesTrashScheduleHost,
): () => void {
  if (!Number.isSafeInteger(host.intervalMs) || host.intervalMs <= 0)
    throw Error("Notes Trash maintenance interval must be a positive integer");
  let stopped = false;
  const due = () => {
    if (!stopped && !host.visibility?.hidden) host.run();
  };
  const visible = () => {
    if (!host.visibility?.hidden) due();
  };
  host.visibility?.addEventListener("visibilitychange", visible);
  const unsubscribe = host.onResume?.(due);
  const set =
    host.setInterval ??
    ((handler: () => void, ms: number) => globalThis.setInterval(handler, ms));
  const clear =
    host.clearInterval ??
    ((handle: unknown) =>
      globalThis.clearInterval(handle as ReturnType<typeof setInterval>));
  const timer = set(due, host.intervalMs);
  return () => {
    if (stopped) return;
    stopped = true;
    host.visibility?.removeEventListener("visibilitychange", visible);
    unsubscribe?.();
    clear(timer);
  };
}
