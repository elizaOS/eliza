import type { ActionJournalEntry } from "./definitions.ts";

/**
 * What a caller may do after `reserve` returns an entry. Only a freshly created or still
 * reserved entry may be dispatched. An applying entry has an unknown outcome and must be
 * reconciled (a saved receipt, or the owner's confirmation), never dispatched again.
 */
export type JournalNextStep =
  | { kind: "dispatch" }
  | { kind: "reconcile"; since: number | null }
  | { kind: "settled"; entry: ActionJournalEntry };

export function nextStep(entry: ActionJournalEntry): JournalNextStep {
  if (entry.phase === "reserved") return { kind: "dispatch" };
  if (entry.phase === "applying")
    return {
      kind: "reconcile",
      since: typeof entry.applyingAt === "number" ? entry.applyingAt : null,
    };
  if (entry.phase === "terminal" && entry.status) {
    // A terminal unknown outcome still needs the owner; it is settled only as a record.
    return entry.status === "unknown"
      ? { kind: "reconcile", since: entry.finishedAt ?? null }
      : { kind: "settled", entry };
  }
  throw new Error("Unrecognized action journal entry");
}

const SCOPE = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9_-]{1,128}$/;

/** Shape check for entries read across the bridge; refuses anything a host could misread. */
export function isJournalEntry(value: unknown): value is ActionJournalEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  if (typeof entry.scope !== "string" || !SCOPE.test(entry.scope)) return false;
  if (typeof entry.proposalId !== "string" || !ID.test(entry.proposalId))
    return false;
  if (typeof entry.operationId !== "string" || !ID.test(entry.operationId))
    return false;
  if (
    typeof entry.operationHash !== "string" ||
    !SCOPE.test(entry.operationHash)
  )
    return false;
  if (
    !entry.record ||
    typeof entry.record !== "object" ||
    Array.isArray(entry.record)
  )
    return false;
  if (typeof entry.createdAt !== "number") return false;
  if (entry.phase === "reserved") return entry.status === undefined;
  if (entry.phase === "applying")
    return typeof entry.attemptId === "string" && entry.status === undefined;
  if (entry.phase !== "terminal") return false;
  return (
    ["succeeded", "failed", "unknown", "cancelled"].includes(
      entry.status as string,
    ) &&
    typeof entry.summary === "string" &&
    (entry.status !== "succeeded" || typeof entry.attemptId === "string")
  );
}
