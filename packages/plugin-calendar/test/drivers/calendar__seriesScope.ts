// spec/calendar/seriesScope.md, "A pending deletion guards the same row until transaction settlement"; spec/calendar/seriesScope.md, "Publish a deletion only with the committed document"
import { Effect, Result } from "effect";
import type { Driver } from "../../gen/calendar__seriesScope.conformance.ts";
import type { DeadlineView, DeleteTx, Event, RowMatch } from "../../gen/calendar__seriesScope.ts";
import {
  occurrenceId, settleDeletions, stageDeletion, undoDeletion,
  type CalendarDocument, type CalendarRow, type DeletionClock, type DeletionOwner, type OwnerFacts,
} from "@elizaos/plugin-calendar-client";

const begin = Date.parse("2026-03-02T17:00:00.000Z");
const series: CalendarRow = { id: "series", calendarId: "local", title: "Standup", body: "", location: "", begin, end: begin + 1_800_000,
  revision: "r1", timeZone: "UTC", repeat: "daily" };
const target = occurrenceId("series", begin + 86_400_000);
const facts: OwnerFacts = { origin: "https://phone.local", ownerId: "owner", agentId: "agent", installationId: "install", enrollmentId: "enroll", sessionId: "s1" };
const created = 1000;
const pristine = (): CalendarDocument => ({ sourceRevision: "source-1", events: [series], deletions: {}, deleteClaims: {} });
const documents = new Map<string, CalendarDocument>();
let minted = 0;

const ownerOf = (key: string): DeletionOwner => ({ kind: "agent", facts, proposalId: `proposal-${key}`, operationId: `operation-${key}`, operationDigest: "digest" });
const entryId = (key: string) => `deletion-${key}`;
const mint = () => `m${++minted}`;
const documentOf = (key: string) => documents.get(key) ?? pristine();

function clockFor(view: DeadlineView): DeletionClock {
  if (view === "ClockChanged") return { continuity: "boot2", elapsed: created + 20_000, wall: 50_000 };
  return { continuity: "boot", elapsed: view === "WindowOpen" ? created + 1 : created + 10_000, wall: 50_000 };
}

function arranged(key: string, document: CalendarDocument, match: RowMatch, sourceCurrent: boolean): CalendarDocument {
  const original = document.deletions[entryId(key)]?.target.row;
  const events = !match.existsNow ? []
    : match.computedNow ? document.events.map((row) => row.id === series.id && !match.ownBytes ? { ...row, title: "Standup, renamed" } : row)
    : original === undefined ? document.events
    : [...document.events, match.exactBytes ? original : { ...original, title: "Standup, edited" }];
  return { ...document, sourceRevision: sourceCurrent ? document.sourceRevision : "source-2", events };
}

async function outcome<A, E>(effect: Effect.Effect<A, E>): Promise<Result.Result<A, E>> {
  return Effect.runPromise(Effect.result(effect));
}

export const driver: Driver<DeleteTx> = {
  reset() {
    documents.clear();
    minted = 0;
  },
  async dispatch(key, event: Event) {
    const document = documentOf(key);
    switch (event.type) {
      case "queueDelete": {
        const staged = await outcome(stageDeletion(document, { id: target, revision: "r1", calendarId: "local" }, ownerOf(key), entryId(key),
          { continuity: "boot", elapsed: created, wall: 40_000 }));
        if (Result.isFailure(staged)) return "refused";
        documents.set(key, staged.success.document);
        return "accepted";
      }
      case "cancelDelete": {
        const now = event.ownerVisible ? { ...facts, sessionId: "s2" } : { ...facts, enrollmentId: "other" };
        const undone = await outcome(undoDeletion(document, entryId(key), clockFor(event.windowView), now));
        if (Result.isFailure(undone)) return "refused";
        documents.set(key, undone.success.document);
        return "accepted";
      }
      case "commitDelete": {
        const now = event.ownerCurrent ? facts : { ...facts, sessionId: "s2" };
        const settled = await Effect.runPromise(settleDeletions(arranged(key, document, event.rowMatch, event.sourceCurrent), clockFor(event.windowView), now, mint));
        if (settled === undefined) return "refused";
        if (event.casSaved) documents.set(key, settled);
        return "accepted";
      }
    }
  },
  observe(key) {
    return documentOf(key).deletions[entryId(key)]?.tx ?? { phase: "DeleteUndone", staged: false, eventPresent: true, writes: 0 };
  },
};
