/**
 * Records append-only, virtual-time evidence across provider requests, model
 * calls, queues, retries, schedules, notifications, and state transitions.
 */
import type { JsonValue } from "./manifest.ts";

export type LedgerKind =
  | "request"
  | "response"
  | "fault"
  | "model"
  | "queue"
  | "retry"
  | "schedule"
  | "notification"
  | "approval"
  | "state-transition"
  | "readback"
  | "lifecycle";

export type LedgerStatus =
  | "started"
  | "succeeded"
  | "failed"
  | "committed"
  | "observed";

export interface LedgerEntry {
  readonly sequence: number;
  readonly id: string;
  readonly namespace: string;
  readonly kind: LedgerKind;
  readonly status: LedgerStatus;
  readonly timestamp: string;
  readonly target: string;
  readonly attempt: number;
  readonly payloadHash: string;
  readonly input?: JsonValue;
  readonly output?: JsonValue;
  readonly idempotencyKey?: string;
  readonly stateTransition?: {
    readonly from: JsonValue;
    readonly to: JsonValue;
  };
  readonly authoritativeReadback?: JsonValue;
  readonly metadata?: Readonly<Record<string, JsonValue>>;
}

export type LedgerAppend = Omit<
  LedgerEntry,
  "sequence" | "id" | "namespace" | "timestamp"
> & {
  readonly timestamp?: string;
};

export class ObservationLedger {
  private entries: LedgerEntry[] = [];
  private sequence = 0;

  public constructor(
    public readonly namespace: string,
    private readonly nowIso: () => string,
  ) {}

  public append(entry: LedgerAppend): LedgerEntry {
    const sequence = ++this.sequence;
    const stored: LedgerEntry = Object.freeze({
      ...structuredClone(entry),
      sequence,
      id: `${this.namespace}:observation:${sequence}`,
      namespace: this.namespace,
      timestamp: entry.timestamp ?? this.nowIso(),
    });
    this.entries.push(stored);
    return structuredClone(stored);
  }

  public all(): readonly LedgerEntry[] {
    return structuredClone(this.entries);
  }

  public byKind(kind: LedgerKind): readonly LedgerEntry[] {
    return structuredClone(this.entries.filter((entry) => entry.kind === kind));
  }

  public clear(): void {
    this.entries = [];
    this.sequence = 0;
  }

  public snapshot(): {
    readonly policy: { readonly excludedTargets: readonly string[] };
    readonly entries: readonly LedgerEntry[];
  } {
    const excludedTargets = ["world.boot"];
    return {
      policy: { excludedTargets },
      entries: this.all().filter(
        (entry) => !excludedTargets.includes(entry.target),
      ),
    };
  }
}
