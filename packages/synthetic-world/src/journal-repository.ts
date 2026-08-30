/** Defines the storage-neutral persistence contract for lease-fenced command journals. */

import type { SyntheticCommandOutcome, SyntheticCommandPhase } from "./types";

export type SyntheticCommandJournalMaybePromise<T> = T | Promise<T>;

export interface SyntheticCommandJournalIdentity {
  namespace: string;
  commandId: string;
}

export interface SyntheticCommandJournalRow
  extends SyntheticCommandJournalIdentity {
  generation: number;
  commandType: string;
  payloadHash: string;
  payloadJson: string;
  phase: SyntheticCommandPhase;
  outcome: SyntheticCommandOutcome;
  resultJson: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  executionToken: string | null;
  createdAtMs: number;
  heartbeatAtMs: number;
  updatedAtMs: number;
  revision: number;
}

export interface SyntheticCommandJournalExpected {
  generation: number;
  phase: SyntheticCommandPhase;
  executionToken: string | null;
  revision: number;
}

export interface SyntheticCommandJournalPatch {
  generation?: number;
  phase?: SyntheticCommandPhase;
  outcome?: SyntheticCommandOutcome;
  resultJson?: string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  executionToken?: string | null;
  heartbeatAtMs: number;
  updatedAtMs: number;
  revision: number;
}

/**
 * Persists journal rows inside the transaction context supplied by the lease
 * store. Implementations must return exact affected-row counts for inserts and
 * compare-and-set updates and must source `now` from their authoritative store.
 */
export interface SyntheticCommandJournalRepository<TContext> {
  initialize(context: TContext): SyntheticCommandJournalMaybePromise<void>;
  now(context: TContext): SyntheticCommandJournalMaybePromise<number>;
  find(
    context: TContext,
    identity: SyntheticCommandJournalIdentity,
  ): SyntheticCommandJournalMaybePromise<SyntheticCommandJournalRow | null>;
  list(
    context: TContext,
    namespace: string,
  ): SyntheticCommandJournalMaybePromise<SyntheticCommandJournalRow[]>;
  insert(
    context: TContext,
    row: SyntheticCommandJournalRow,
  ): SyntheticCommandJournalMaybePromise<number>;
  compareAndSet(
    context: TContext,
    identity: SyntheticCommandJournalIdentity,
    expected: SyntheticCommandJournalExpected,
    patch: SyntheticCommandJournalPatch,
  ): SyntheticCommandJournalMaybePromise<number>;
}
