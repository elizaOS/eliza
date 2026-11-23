// spec/os/android/deferredDeletion.md, "Story: Keep one winner between Undo and the provider"; spec/os/android/deferredDeletion.md, "Story: Respect the owner when the session changes"; spec/os/android/deferredDeletion.md, "Story: Undo a deleted message, conversation, voicemail or contact"; spec/os/android/deletionWindow.md, "Story: Undo a reviewed deletion before it is sent"
import type { DeletionHold, DeletionKind } from "../../../gen/os__android__deferredDeletion.ts";
import type { DeletionNotice, DeletionPhase, WindowState } from "../../../gen/os__android__deletionWindow.ts";

export type JournalScope = string;
export type ProposalId = string;
export type OperationId = string;
export type OperationHash = string;

export type ActionJournalStatus = "succeeded" | "failed" | "unknown" | "cancelled";

interface JournalEntryBase {
  readonly scope: JournalScope;
  readonly proposalId: ProposalId;
  readonly operationId: OperationId;
  readonly operationHash: OperationHash;
  readonly record: Readonly<Record<string, unknown>>;
  readonly createdAt: number;
}

export interface ReservedEntry extends JournalEntryBase {
  readonly phase: "reserved";
}

export interface ApplyingEntry extends JournalEntryBase {
  readonly phase: "applying";
  readonly attemptId: string;
  readonly applyingAt?: number;
}

export interface TerminalEntry extends JournalEntryBase {
  readonly phase: "terminal";
  readonly status: ActionJournalStatus;
  readonly summary: string;
  readonly attemptId?: string;
  readonly applyingAt?: number;
  readonly finishedAt?: number;
  readonly result?: Readonly<Record<string, unknown>>;
}

export type ActionJournalEntry = ReservedEntry | ApplyingEntry | TerminalEntry;

export type ActionJournalPhase = ActionJournalEntry["phase"];

export type JournalNextStep =
  | { readonly kind: "dispatch" }
  | { readonly kind: "reconcile"; readonly since: number | null }
  | { readonly kind: "settled"; readonly entry: ActionJournalEntry };

export interface ActionJournalTarget {
  readonly scope: JournalScope;
  readonly proposalId: ProposalId;
}

export interface JournalReservation extends ActionJournalTarget {
  readonly operationId: OperationId;
  readonly operationHash: OperationHash;
  readonly record: Readonly<Record<string, unknown>>;
}

export interface JournalFinish extends ActionJournalTarget {
  readonly status: ActionJournalStatus;
  readonly summary: string;
  readonly result?: Readonly<Record<string, unknown>>;
}

export type DeletionRecordKind = "calendar" | "reminder" | "message" | "thread" | "voicemail" | "contact";

export type StagedRecordKind = Extract<DeletionRecordKind, "message" | "thread" | "voicemail" | "contact">;

export interface DeferredDeletionKey {
  readonly kind: DeletionKind;
  readonly id: string;
}

export interface DeferredDeletionEntry extends DeferredDeletionKey {
  readonly phase: DeletionPhase;
  readonly window: WindowState;
  readonly hold: DeletionHold;
  readonly expiresAt: number | null;
  readonly title: string | null;
  readonly record: string | null;
}

export interface StagedDeletion extends DeferredDeletionKey {
  readonly expiresAt: number;
}

export interface DeletedRecordOrigin {
  readonly kind: "event" | "reminder";
  readonly id: string;
}

export interface DeferredDeletionsPending {
  readonly deletions: readonly DeferredDeletionEntry[];
  readonly deletedOrigins: readonly DeletedRecordOrigin[];
}

export interface DeletionNoticeView {
  readonly key: string;
  readonly title: string;
  readonly notice: Exclude<DeletionNotice, "NoticeHidden">;
  readonly message: string;
  readonly canUndo: boolean;
  readonly uncertain: boolean;
}

export type UndoOutcome = { readonly kind: "Kept" } | { readonly kind: "NotKept"; readonly message: string };

export type DismissOutcome = { readonly kind: "Dismissed"; readonly message: string } | { readonly kind: "NotDismissed"; readonly message: string };

export interface ActionJournalPlugin {
  reserve(input: JournalReservation): Promise<unknown>;
  markApplying(input: ActionJournalTarget & { readonly attemptId: string }): Promise<unknown>;
  finish(input: JournalFinish): Promise<unknown>;
  get(input: ActionJournalTarget): Promise<unknown>;
  list(input: { readonly scope: JournalScope }): Promise<unknown>;
  pending(): Promise<unknown>;
  undo(input: { readonly kind: DeletionRecordKind; readonly id: string }): Promise<unknown>;
  dismiss(input: { readonly kind: DeletionRecordKind; readonly id: string }): Promise<unknown>;
}

export interface ActionJournalClient {
  reserve(input: JournalReservation): Promise<{ readonly created: boolean; readonly entry: ActionJournalEntry }>;
  markApplying(input: ActionJournalTarget & { readonly attemptId: string }): Promise<ActionJournalEntry>;
  finish(input: JournalFinish): Promise<ActionJournalEntry>;
  get(input: ActionJournalTarget): Promise<ActionJournalEntry | null>;
  list(scope: JournalScope): Promise<readonly ActionJournalEntry[]>;
}

export interface DeferredDeletionsClient {
  pending(): Promise<DeferredDeletionsPending>;
  undo(key: DeferredDeletionKey): Promise<UndoOutcome>;
  dismiss(key: DeferredDeletionKey): Promise<DismissOutcome>;
}
