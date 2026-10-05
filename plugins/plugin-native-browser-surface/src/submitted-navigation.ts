/** State for addresses explicitly submitted by a host. This cannot observe iframe
 * navigation or certify loaded content; the host retains sandbox and warning UI. */
export interface SubmittedNavigationVerdict {
  readonly status: "no-known-threat" | "blocked" | "lookalike" | "unavailable";
  readonly reason?: string;
  readonly source?: string;
  readonly suggested?: string;
}
export interface SubmittedNavigationState {
  readonly history: readonly string[];
  readonly index: number;
  readonly revision: number;
  readonly address: string | null;
  readonly verdict: SubmittedNavigationVerdict | null;
  readonly permitted: boolean;
}

export class SubmittedNavigation {
  private state: SubmittedNavigationState = Object.freeze({
    history: Object.freeze([]),
    index: -1,
    revision: 0,
    address: null,
    verdict: null,
    permitted: false,
  });
  private readonly listeners = new Set<() => void>();
  constructor(
    private readonly options: {
      check: (address: string) => Promise<SubmittedNavigationVerdict>;
    },
  ) {}
  readonly snapshot = (): SubmittedNavigationState => this.state;
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private publish(state: SubmittedNavigationState): void {
    this.state = Object.freeze(state);
    for (const listener of this.listeners) listener();
  }
  private select(history: readonly string[], index: number): void {
    const revision = this.state.revision + 1;
    const address = history[index] ?? null;
    this.publish({
      history: Object.freeze([...history]),
      index,
      revision,
      address,
      verdict: null,
      permitted: false,
    });
    if (!address) return;
    // A subscriber may synchronously close/navigate while receiving the reset.
    if (this.state.revision !== revision) return;
    void (async () => {
      let verdict: SubmittedNavigationVerdict = { status: "unavailable" };
      try {
        const result = await this.options.check(address);
        if (
          ["no-known-threat", "blocked", "lookalike", "unavailable"].includes(
            result.status,
          ) &&
          [result.reason, result.source, result.suggested].every(
            (value) => value === undefined || typeof value === "string",
          )
        ) {
          verdict = {
            status: result.status,
            reason: result.reason,
            source: result.source,
            suggested: result.suggested,
          };
        }
      } catch {
        /* A failed or malformed check never permits navigation. */
      }
      if (this.state.revision !== revision) return;
      this.publish({
        ...this.state,
        verdict: Object.freeze(verdict),
        permitted: verdict.status === "no-known-threat",
      });
    })();
  }
  /** Host resolves/validates addresses before supplying them. */
  open(address: string): void {
    this.select([address], 0);
  }
  close(): void {
    this.select([], -1);
  }
  navigate(address: string): void {
    this.select(
      [...this.state.history.slice(0, this.state.index + 1), address],
      this.state.index + 1,
    );
  }
  move(index: number): boolean {
    if (
      !Number.isInteger(index) ||
      index < 0 ||
      index >= this.state.history.length
    )
      return false;
    this.select(this.state.history, index);
    return true;
  }
  reload(): void {
    if (this.state.address) this.select(this.state.history, this.state.index);
  }
  /** Must follow the host's explicit gesture for this exact navigation revision. */
  allowOnce(revision: number): boolean {
    if (
      revision !== this.state.revision ||
      this.state.verdict === null ||
      !this.state.address
    )
      return false;
    this.publish({ ...this.state, permitted: true });
    return true;
  }
}
