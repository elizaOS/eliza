import type { NotesSnapshot, StickyNote } from "../types.js";

/** Owner-scoped projection shared by React and embedded Notes clients.
 * Hosts own request scheduling and supply an opaque current-authority token.
 * Undefined means inactive. A snapshot never grants authority to its caller.
 */
export class NotesSnapshotState {
  private readonly lifetime = new AbortController();
  private value: { authority: unknown; snapshot: NotesSnapshot } | null = null;

  constructor(private readonly currentAuthority: () => unknown) {}

  get signal(): AbortSignal {
    return this.lifetime.signal;
  }
  get current(): boolean {
    try {
      return !this.signal.aborted && this.currentAuthority() !== undefined;
    } catch {
      return false;
    }
  }
  assertCurrent(signal: AbortSignal = this.signal): void {
    signal.throwIfAborted();
    this.signal.throwIfAborted();
    if (this.currentAuthority() === undefined)
      throw new DOMException("The Notes connection changed.", "AbortError");
  }
  private currentSnapshot(): NotesSnapshot | null {
    const value = this.value;
    return this.current && value && value.authority === this.currentAuthority()
      ? value.snapshot
      : null;
  }
  get snapshot(): NotesSnapshot | null {
    const snapshot = this.currentSnapshot();
    return snapshot ? structuredClone(snapshot) : null;
  }
  get revision(): number | null {
    return this.currentSnapshot()?.revision ?? null;
  }
  hasNote(id: string): boolean {
    return !!this.currentSnapshot()?.notes.some((note) => note.id === id);
  }
  note(id: string): StickyNote | undefined {
    const note = this.currentSnapshot()?.notes.find((note) => note.id === id);
    return note ? structuredClone(note) : undefined;
  }
  accept(
    snapshot: NotesSnapshot,
    authority = this.currentAuthority(),
  ): "accepted" | "stale" | "retired" {
    if (!this.current || authority !== this.currentAuthority())
      return "retired";
    const value = this.value;
    if (
      value &&
      value.authority === authority &&
      snapshot.revision < value.snapshot.revision
    )
      return "stale";
    this.value = { authority, snapshot: structuredClone(snapshot) };
    return "accepted";
  }
  retire(): void {
    this.lifetime.abort();
    this.value = null;
  }
}
