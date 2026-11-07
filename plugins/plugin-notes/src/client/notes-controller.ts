import type { NotesSnapshot } from "../types.js";
import type { NotesClient, NotesInteractResult } from "./notes-api.js";
import { NotesSnapshotState } from "./notes-snapshot-state.js";

/** Serial embedded-host Notes lifecycle over the canonical client. */
export type NotesPhase = "loading" | "ready" | "saving" | "review" | "retired";
export interface NotesControllerHooks {
  snapshot(snapshot: NotesSnapshot, reason: "read" | "interact"): void;
  phase(phase: NotesPhase): void;
  /** Preserve transport classification for recovery UI. Retired owners and
   * deliberate request cancellation do not report failures. */
  failed?(cause: unknown, operation: "read" | "interact"): void;
}
export class NotesController {
  private readonly state: NotesSnapshotState;
  private read: Promise<NotesSnapshot> | null = null;
  private writing = false;
  private readAbort: AbortController | null = null;
  private invalidated = false;
  constructor(
    private readonly notes: NotesClient,
    current: () => boolean,
    private readonly hooks: NotesControllerHooks,
  ) {
    this.state = new NotesSnapshotState(() => (current() ? this : undefined));
  }
  private assertCurrent(signal: AbortSignal = this.state.signal): void {
    this.state.assertCurrent(signal);
  }
  get snapshot(): NotesSnapshot | null {
    return this.state.snapshot;
  }
  get revision(): number | null {
    return this.state.revision;
  }
  hasViewNote(id: string): boolean {
    return this.state.hasNote(id);
  }
  viewNote(id: string) {
    return this.state.note(id);
  }
  get pending(): boolean {
    return this.writing;
  }
  get current(): boolean {
    return this.state.current;
  }
  private publish(value: NotesSnapshot, reason: "read" | "interact"): void {
    this.assertCurrent();
    if (this.state.accept(value) === "stale")
      throw Error("The Notes response is older than the current collection.");
    this.hooks.snapshot(structuredClone(value), reason);
  }
  /** One initial/reload/resume read. Multiple in-flight invalidations coalesce. */
  async refresh(): Promise<NotesSnapshot> {
    this.assertCurrent();
    if (this.writing) {
      this.invalidated = true;
      throw Error("Wait for the current Notes operation.");
    }
    if (this.read) return this.read;
    this.invalidated = false;
    this.hooks.phase("loading");
    const abort = new AbortController();
    this.readAbort = abort;
    const pending = this.notes
      .readState(anyAbortSignal([this.state.signal, abort.signal]))
      .then((value) => {
        this.publish(value, "read");
        this.hooks.phase("ready");
        return structuredClone(value);
      })
      .catch((error) => {
        if (this.current && !abort.signal.aborted) {
          this.hooks.failed?.(error, "read");
          this.hooks.phase("review");
        }
        throw error;
      });
    this.read = pending;
    try {
      return await pending;
    } finally {
      if (this.read === pending) {
        this.read = null;
        this.readAbort = null;
      }
      if (this.invalidated && this.current && !this.writing) {
        this.invalidated = false;
        void this.refresh().catch(() => {});
      }
    }
  }
  /** Authenticated same-session event payloads contain only revision/mutation.
   * A same/older revision already returned by our mutation needs no extra GET. */
  invalidate(revision?: number): void {
    if (!this.current) return;
    if (
      revision !== undefined &&
      this.revision !== null &&
      Number.isSafeInteger(revision) &&
      revision <= this.revision
    )
      return;
    if (this.read || this.writing) {
      this.invalidated = true;
      return;
    }
    void this.refresh().catch(() => {});
  }
  /** Explicit UI command; parameters and all domain validation stay canonical.
   * Never infer a newly created identity by diffing the returned collection. */
  async interact(
    capability: string,
    params?: Record<string, unknown>,
  ): Promise<NotesInteractResult> {
    this.assertCurrent();
    if (this.writing) throw Error("A Notes operation is already pending.");
    this.writing = true;
    if (this.readAbort) {
      this.readAbort.abort();
      this.readAbort = null;
      this.read = null;
      this.invalidated = true;
    }
    this.hooks.phase("saving");
    try {
      const result = await this.notes.interact(
        capability,
        params,
        this.state.signal,
      );
      this.assertCurrent();
      this.publish(result.state, "interact");
      this.hooks.phase("ready");
      return result;
    } catch (error) {
      if (this.current) {
        this.hooks.failed?.(error, "interact");
        this.hooks.phase("review");
      }
      throw error;
    } finally {
      this.writing = false;
      if (this.invalidated && this.current) {
        this.invalidated = false;
        void this.refresh().catch(() => {});
      }
    }
  }
  retire(): void {
    if (this.state.signal.aborted) return;
    this.invalidated = false;
    this.state.retire();
    this.hooks.phase("retired");
  }
}

/** Compose request cancellation on WebViews without AbortSignal.any. */
function anyAbortSignal(signals: readonly AbortSignal[]): AbortSignal {
  if (typeof AbortSignal.any === "function")
    return AbortSignal.any([...signals]);
  const controller = new AbortController(),
    listeners = new Map<AbortSignal, () => void>();
  const cleanup = () => {
    for (const [source, listener] of listeners)
      source.removeEventListener("abort", listener);
    listeners.clear();
  };
  for (const signal of new Set(signals)) {
    if (signal.aborted) {
      cleanup();
      controller.abort(signal.reason);
      break;
    }
    const listener = () => {
      cleanup();
      controller.abort(signal.reason);
    };
    listeners.set(signal, listener);
    signal.addEventListener("abort", listener, { once: true });
  }
  return controller.signal;
}
