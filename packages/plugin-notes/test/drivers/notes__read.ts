// spec/notes/read.md, "Story: Search private notes and share only what I select"
import { Deferred, Effect, Fiber } from "effect";
import type { Driver, Options } from "../../gen/notes__read.conformance.ts";
import type { NoteRead, NoteReadPhase } from "../../gen/notes__read.ts";
import { selectedNotes, type NotesAuthority, type NotesClaim, type NotesOwner, type NotesProposal, type PreparedNotesRead } from "@elizaos/plugin-notes-client";

type View = Pick<NoteRead, "phase" | "generation" | "candidate" | "selected" | "receipt">;
const view = ({ phase, generation, candidate, selected, receipt }: NoteRead): View => ({
  phase,
  generation,
  candidate,
  selected,
  receipt,
});

const OWNER: NotesOwner = {
  ownerId: "owner-1",
  agentId: "agent-1",
  installationId: "inst-1",
  enrollmentId: "enroll-1",
  origin: "https://notes.local",
  scope: "notes.read",
};

const PROPOSAL: NotesProposal = {
  proposalId: "prop-1",
  operationId: "op-1",
  digest: "digest-1",
  owner: OWNER,
};

const CLAIM: NotesClaim = {
  proposalId: "prop-1",
  operationId: "op-1",
  attemptId: 1,
};

const AUTHORITY: NotesAuthority = {
  ...PROPOSAL,
  viewRevision: 1,
  view: "notes",
  foreground: true,
  permitted: true,
};

interface Gate {
  readonly entered: Deferred.Deferred<void>;
  readonly reply: Deferred.Deferred<boolean>;
}

interface Session {
  readonly reader: Effect.Success<ReturnType<typeof selectedNotes>>;
  phase: NoteReadPhase;
  generation: number;
  candidate: number;
  selected: number;
  queryRevision: number;
  receipt: number;
  docRaw: string;
  reviewGate: Gate | undefined;
  prepareFiber: Fiber.Fiber<PreparedNotesRead, unknown> | undefined;
  prepared: PreparedNotesRead | undefined;
}

const sessions = new Map<string, Session>();

function makeGate(): Gate {
  return {
    entered: Effect.runSync(Deferred.make<void>()),
    reply: Effect.runSync(Deferred.make<boolean>()),
  };
}

function makeDocument(count: number): string {
  const records = Array.from({ length: Math.max(count, 1) }, (_, index) => ({
    id: `note-${index + 1}`,
    kind: "text" as const,
    title: `Match ${index + 1}`,
    body: `Body ${index + 1}`,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  }));
  return JSON.stringify({
    version: 2,
    collectionId: "11111111-1111-1111-1111-111111111111",
    records,
    deleted: [],
  });
}

function sessionOf(key: string): Session {
  const existing = sessions.get(key);
  if (existing !== undefined) return existing;
  const created = {
    phase: "Idle" as NoteReadPhase,
    generation: 0,
    candidate: 0,
    selected: 0,
    queryRevision: 0,
    receipt: 0,
    docRaw: makeDocument(1),
    reviewGate: undefined as Gate | undefined,
    prepareFiber: undefined as Fiber.Fiber<PreparedNotesRead, unknown> | undefined,
    prepared: undefined as PreparedNotesRead | undefined,
  };
  const reader = Effect.runSync(
    selectedNotes({
      current: () => AUTHORITY,
      readCommitted: () => Effect.succeed({ revision: "rev-1", raw: created.docRaw }),
      choose: (choices) => Effect.succeed(choices[0]?.id),
      review: () =>
        Effect.gen(function* () {
          const gate = created.reviewGate;
          if (gate === undefined) return false;
          yield* Deferred.succeed(gate.entered, undefined);
          return yield* Deferred.await(gate.reply);
        }),
      hasClaim: () => true,
    }),
  );
  const session: Session = Object.assign(created, { reader });
  sessions.set(key, session);
  return session;
}

export const driver: Driver<View> = {
  reset() {
    sessions.clear();
  },
  async dispatch(key, event) {
    const session = sessionOf(key);
    switch (event.type) {
      case "startQuery": {
        if (session.phase === "Choosing" || session.phase === "Approved" || event.revision <= 0 || event.candidateId < 0) return "refused";
        session.prepared = undefined;
        if (event.candidateId === 0) {
          session.docRaw = makeDocument(1);
          const prepared = await Effect.runPromise(
            session.reader.prepare({ type: "notes_query", query: { kind: "title", text: "NO-SUCH-NOTE" } }, PROPOSAL),
          );
          session.prepared = prepared;
          session.generation += 1;
          session.phase = "NoResult";
          session.candidate = 0;
          session.selected = 0;
          session.queryRevision = event.revision;
          session.receipt = 0;
          return "accepted";
        }
        session.docRaw = makeDocument(event.candidateId);
        const gate = makeGate();
        session.reviewGate = gate;
        session.prepareFiber = Effect.runFork(
          session.reader.prepare({ type: "notes_query", query: { kind: "title", text: `Match ${event.candidateId}` } }, PROPOSAL),
        );
        await Effect.runPromise(Deferred.await(gate.entered));
        session.generation += 1;
        session.phase = "Choosing";
        session.candidate = event.candidateId;
        session.selected = 0;
        session.queryRevision = event.revision;
        session.receipt = 0;
        return "accepted";
      }
      case "approveShare": {
        if (
          session.phase !== "Choosing"
          || event.noteId !== session.candidate
          || event.generationId !== session.generation
          || event.revision !== session.queryRevision
          || session.reviewGate === undefined
          || session.prepareFiber === undefined
        ) {
          return "refused";
        }
        const gate = session.reviewGate;
        const fiber = session.prepareFiber;
        session.reviewGate = undefined;
        session.prepareFiber = undefined;
        await Effect.runPromise(Deferred.succeed(gate.reply, true));
        session.prepared = await Effect.runPromise(Fiber.join(fiber));
        session.phase = "Approved";
        session.selected = event.noteId;
        return "accepted";
      }
      case "finishShare": {
        if (
          session.phase !== "Approved"
          || event.noteId !== session.selected
          || event.generationId !== session.generation
          || event.revision !== session.queryRevision
          || !event.exactFields
          || session.prepared === undefined
        ) {
          return "refused";
        }
        const prepared = session.prepared;
        session.prepared = undefined;
        const receipt = await Effect.runPromise(prepared.execute(CLAIM));
        if (receipt.kind !== "notes_query" || receipt.basis === "no-match") return "refused";
        session.phase = "Shared";
        session.receipt = event.noteId;
        return "accepted";
      }
      case "retireQuery": {
        if (session.phase !== "Choosing" && session.phase !== "Approved") return "refused";
        if (session.phase === "Choosing" && session.reviewGate !== undefined && session.prepareFiber !== undefined) {
          const gate = session.reviewGate;
          const fiber = session.prepareFiber;
          session.reviewGate = undefined;
          session.prepareFiber = undefined;
          await Effect.runPromise(Deferred.succeed(gate.reply, false));
          await Effect.runPromise(Fiber.await(fiber));
        } else if (session.phase === "Approved" && session.prepared !== undefined) {
          const prepared = session.prepared;
          session.prepared = undefined;
          await Effect.runPromise(Effect.exit(prepared.execute({ ...CLAIM, attemptId: 0 })));
        }
        session.generation += 1;
        session.phase = "Refused";
        session.candidate = 0;
        session.selected = 0;
        session.queryRevision = 0;
        session.receipt = 0;
        return "accepted";
      }
      default: {
        const unreachable: never = event;
        return unreachable;
      }
    }
  },
  observe(key): View {
    const session = sessionOf(key);
    return {
      phase: session.phase,
      generation: session.generation,
      candidate: session.candidate,
      selected: session.selected,
      receipt: session.receipt,
    };
  },
};

export const options: Options<View> = { view, keys: ["notes"] };
