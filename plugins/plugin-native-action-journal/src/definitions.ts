/**
 * Bridge contract of the Android action journal (`android/README.md`). The host chooses the
 * Capacitor name and may add its own recovery methods. Nothing here performs an action or
 * grants approval: a journal entry records what an approved dispatch did, at most once.
 */
export type ActionJournalPhase = "reserved" | "applying" | "terminal";
export type ActionJournalStatus =
  | "succeeded"
  | "failed"
  | "unknown"
  | "cancelled";

export interface ActionJournalEntry {
  /** 64 lowercase hex characters naming the owner/agent/device binding. */
  scope: string;
  proposalId: string;
  operationId: string;
  /** SHA-256 (hex) of the exact approved operation. */
  operationHash: string;
  record: Record<string, unknown>;
  phase: ActionJournalPhase;
  createdAt: number;
  attemptId?: string;
  applyingAt?: number;
  status?: ActionJournalStatus;
  summary?: string;
  finishedAt?: number;
  result?: Record<string, unknown>;
}

export interface ActionJournalScope {
  scope: string;
}
export interface ActionJournalTarget extends ActionJournalScope {
  proposalId: string;
}

export interface ActionJournalPlugin {
  /** Creates the entry, or returns the identical stored one (`created: false`); a changed replay rejects. */
  reserve(
    input: ActionJournalTarget & {
      operationId: string;
      operationHash: string;
      record: Record<string, unknown>;
    },
  ): Promise<{ created: boolean; entry: ActionJournalEntry }>;
  /** Records dispatch intent. Only a reserved entry may start applying. */
  markApplying(
    input: ActionJournalTarget & { attemptId: string },
  ): Promise<{ entry: ActionJournalEntry }>;
  /** The single terminal transition; an identical replay resolves with the stored entry. */
  finish(
    input: ActionJournalTarget & {
      status: ActionJournalStatus;
      summary: string;
      result?: Record<string, unknown>;
    },
  ): Promise<{ entry: ActionJournalEntry }>;
  get(
    input: ActionJournalTarget,
  ): Promise<{ entry: ActionJournalEntry | null }>;
  /** Reservation order, through the host's redacting list view. */
  list(input: ActionJournalScope): Promise<{ entries: ActionJournalEntry[] }>;
}
