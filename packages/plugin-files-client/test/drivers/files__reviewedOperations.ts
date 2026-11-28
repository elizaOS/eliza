// spec/files/reviewedOperations.md, "Story: Act only on the file revision I reviewed"
import { Clock, Deferred, Effect, Fiber, Layer } from "effect"
import type { Driver, Options } from "../../gen/files__reviewedOperations.conformance.ts"
import type { TrashPhase, TrashRow } from "../../gen/files__reviewedOperations.ts"
import {
  FilesVolume,
  LIBRARY_ROOT,
  LibraryFailed,
  LibraryRefused,
  LibraryStore,
  TRASH,
  libraryVolume,
  type LibraryRow,
} from "../../src/index.vibe"

const EXPIRY_MS = 2_592_000_000
const NOTE_ID = "file-note"

interface Gate {
  readonly entered: Deferred.Deferred<void>
  readonly reply: Deferred.Deferred<boolean>
}

interface Session {
  readonly rows: Map<string, LibraryRow>
  readonly volume: FilesVolume.Shape
  readonly clock: Clock.Clock
  now: number
  phase: TrashPhase
  deletedAt: number
  trashId: string | undefined
  moveGate: Gate | undefined
  undoGate: Gate | undefined
  pruneDataGate: Gate | undefined
  pruneInfoGate: Gate | undefined
  trashFiber: Fiber.Fiber<unknown, unknown> | undefined
  pruneFiber: Fiber.Fiber<unknown, unknown> | undefined
}

const sessions = new Map<string, Session>()

function makeGate(): Gate {
  return {
    entered: Effect.runSync(Deferred.make<void>()),
    reply: Effect.runSync(Deferred.make<boolean>()),
  }
}

function makeClock(session: { now: number }): Clock.Clock {
  return {
    currentTimeMillisUnsafe: () => session.now,
    currentTimeMillis: Effect.sync(() => session.now),
    currentTimeNanosUnsafe: () => BigInt(session.now) * 1_000_000n,
    currentTimeNanos: Effect.sync(() => BigInt(session.now) * 1_000_000n),
    monotonicTimeNanosUnsafe: () => BigInt(session.now) * 1_000_000n,
    monotonicTimeNanos: Effect.sync(() => BigInt(session.now) * 1_000_000n),
    sleep: () => Effect.void,
  }
}

function trashFolderId(rows: Map<string, LibraryRow>): string | undefined {
  for (const row of rows.values()) {
    if (row.parentId === LIBRARY_ROOT && row.directory && row.name === TRASH) return row.id
  }
  return undefined
}

function journalRowId(rows: Map<string, LibraryRow>, trashId: string | undefined): string | undefined {
  const folderId = trashFolderId(rows)
  if (folderId === undefined) return undefined
  for (const row of rows.values()) {
    if (row.parentId !== folderId || !row.name.endsWith(".json")) continue
    if (trashId === undefined || row.name === `${trashId}.json`) return row.id
  }
  return undefined
}

function makeSession(key: string): Session {
  const rows = new Map<string, LibraryRow>()
  const state = {
    rows,
    now: 0,
    phase: "Visible" as TrashPhase,
    deletedAt: 0,
    trashId: undefined as string | undefined,
    moveGate: undefined as Gate | undefined,
    undoGate: undefined as Gate | undefined,
    pruneDataGate: undefined as Gate | undefined,
    pruneInfoGate: undefined as Gate | undefined,
    trashFiber: undefined as Fiber.Fiber<unknown, unknown> | undefined,
    pruneFiber: undefined as Fiber.Fiber<unknown, unknown> | undefined,
  }
  const clock = makeClock(state)

  const gatedStore = Layer.succeed(LibraryStore, {
    rows: () => Effect.sync(() => [...rows.values()]),
    commit: (plan) =>
      Effect.gen(function* () {
        const snapshot = [...rows.values()]
        const outcome = plan(snapshot)
        if (typeof outcome === "string") {
          return yield* Effect.fail(new LibraryRefused({ answer: outcome, message: outcome }))
        }
        const trashId = trashFolderId(rows)
        const movingNote =
          state.moveGate !== undefined &&
          trashId !== undefined &&
          outcome.put.some((entry) => entry.id === NOTE_ID && entry.parentId === trashId)
        if (movingNote) {
          const gate = state.moveGate!
          yield* Deferred.succeed(gate.entered, undefined)
          const ok = yield* Deferred.await(gate.reply)
          if (!ok) return yield* Effect.fail(new LibraryFailed({ message: "injected move failure" }))
        }
        const infoRow = journalRowId(rows, state.trashId)
        const removingInfo = infoRow !== undefined && outcome.remove.includes(infoRow)
        if (removingInfo && state.undoGate !== undefined) {
          const gate = state.undoGate
          yield* Deferred.succeed(gate.entered, undefined)
          const ok = yield* Deferred.await(gate.reply)
          if (!ok) return yield* Effect.fail(new LibraryFailed({ message: "injected undo failure" }))
        }
        const removingData = outcome.remove.includes(NOTE_ID)
        if (removingData && state.pruneDataGate !== undefined) {
          const gate = state.pruneDataGate
          yield* Deferred.succeed(gate.entered, undefined)
          const ok = yield* Deferred.await(gate.reply)
          if (!ok) return yield* Effect.fail(new LibraryFailed({ message: "injected prune data failure" }))
        }
        if (removingInfo && state.pruneInfoGate !== undefined) {
          const gate = state.pruneInfoGate
          yield* Deferred.succeed(gate.entered, undefined)
          const ok = yield* Deferred.await(gate.reply)
          if (!ok) return yield* Effect.fail(new LibraryFailed({ message: "injected prune info failure" }))
        }
        for (const id of outcome.remove) rows.delete(id)
        for (const next of outcome.put) rows.set(next.id, next)
      }),
  })

  const volume = Effect.runSync(Effect.provide(FilesVolume, libraryVolume().pipe(Layer.provide(gatedStore))))
  const session: Session = Object.assign(state, { volume, clock })
  sessions.set(key, session)
  return session
}

function sessionOf(key: string): Session {
  return sessions.get(key) ?? makeSession(key)
}

function onClock<A, E>(session: Session, eff: Effect.Effect<A, E>): Effect.Effect<A, E> {
  return Effect.provideService(eff, Clock.Clock, session.clock)
}

function readTrashRows(session: Session): { readonly journal: boolean; readonly resident: boolean; readonly row?: TrashRow } {
  const folderId = trashFolderId(session.rows)
  if (folderId === undefined) return { journal: false, resident: false }
  const children = [...session.rows.values()].filter((entry) => entry.parentId === folderId)
  const infoEntry = session.trashId === undefined
    ? children.find((entry) => entry.name.endsWith(".json"))
    : children.find((entry) => entry.name === `${session.trashId}.json`)
  const id = session.trashId ?? infoEntry?.name.slice(0, -".json".length)
  if (id === undefined) return { journal: false, resident: false }
  const journal = infoEntry !== undefined
  const resident = children.some((entry) => entry.name === id)
  if (!journal || infoEntry.bytes === undefined) return { journal, resident }
  try {
    const parsed = JSON.parse(new TextDecoder().decode(infoEntry.bytes)) as { row?: TrashRow }
    return { journal, resident, row: parsed.row }
  } catch {
    return { journal, resident }
  }
}

function isAdmittedTrash(op: string, row: {
  readonly validPath: boolean
  readonly pathExists: boolean
  readonly reviewRequired: boolean
  readonly reviewMatches: boolean
  readonly currentOwner: boolean
  readonly sameFolder: boolean
  readonly descendant: boolean
}): boolean {
  if (op !== "Trash") return false
  if (!row.validPath || !row.currentOwner || !row.pathExists) return false
  return !row.reviewRequired || row.reviewMatches
}

async function releaseSession(session: Session): Promise<void> {
  for (const gate of [session.moveGate, session.undoGate, session.pruneDataGate, session.pruneInfoGate]) {
    if (gate !== undefined) await Effect.runPromise(Deferred.succeed(gate.reply, false))
  }
  if (session.trashFiber !== undefined) await Effect.runPromise(Fiber.interrupt(session.trashFiber))
  if (session.pruneFiber !== undefined) await Effect.runPromise(Fiber.interrupt(session.pruneFiber))
}

export const driver: Driver<TrashRow> = {
  async reset() {
    for (const session of sessions.values()) await releaseSession(session)
    sessions.clear()
  },
  async dispatch(key, event) {
    const session = sessionOf(key)
    switch (event.type) {
      case "journal": {
        if (session.phase !== "Visible" || event.at < 0 || !isAdmittedTrash(event.op, event.row)) return "refused"
        const bytes = new TextEncoder().encode("data")
        session.rows.set(NOTE_ID, {
          id: NOTE_ID,
          parentId: LIBRARY_ROOT,
          name: "note.txt",
          mimeType: "text/plain",
          directory: false,
          size: bytes.byteLength,
          revision: "rev-1",
          createdAt: event.at,
          modifiedAt: event.at,
          bytes,
        })
        session.now = event.at
        session.deletedAt = event.at
        const moveGate = makeGate()
        const undoGate = makeGate()
        session.moveGate = moveGate
        session.undoGate = undoGate
        const tokens = event.row.reviewRequired
          ? await Effect.runPromise(onClock(session, session.volume.reviewedIdentities(["note.txt"])))
          : undefined
        session.trashFiber = Effect.runFork(
          onClock(session, session.volume.trash({ paths: ["note.txt"], ...(tokens === undefined ? {} : { reviewed: tokens }) })),
        )
        await Effect.runPromise(Deferred.await(moveGate.entered))
        const folderId = trashFolderId(session.rows)
        const info = folderId === undefined
          ? undefined
          : [...session.rows.values()].find((entry) => entry.parentId === folderId && entry.name.endsWith(".json"))
        session.trashId = info?.name.slice(0, -".json".length)
        session.phase = "Journaled"
        return "accepted"
      }
      case "moveToTrash": {
        if (session.phase !== "Journaled" || session.moveGate === undefined || session.undoGate === undefined) return "refused"
        const moveGate = session.moveGate
        const undoGate = session.undoGate
        session.moveGate = undefined
        await Effect.runPromise(Deferred.succeed(moveGate.reply, event.acknowledged))
        if (event.acknowledged) {
          session.undoGate = undefined
          if (session.trashFiber !== undefined) await Effect.runPromise(Fiber.await(session.trashFiber))
          session.trashFiber = undefined
          session.phase = "InTrash"
        } else {
          await Effect.runPromise(Deferred.await(undoGate.entered))
          session.phase = "MoveFailed"
        }
        return "accepted"
      }
      case "undoFailedJournal": {
        if (session.phase !== "MoveFailed" || session.undoGate === undefined) return "refused"
        const undoGate = session.undoGate
        session.undoGate = undefined
        await Effect.runPromise(Deferred.succeed(undoGate.reply, true))
        if (session.trashFiber !== undefined) await Effect.runPromise(Fiber.await(session.trashFiber))
        session.trashFiber = undefined
        session.trashId = undefined
        session.deletedAt = 0
        session.phase = "Visible"
        return "accepted"
      }
      case "prune": {
        if (session.phase !== "InTrash" || event.at - session.deletedAt < EXPIRY_MS) return "refused"
        session.now = event.at
        const dataGate = makeGate()
        const infoGate = makeGate()
        session.pruneDataGate = dataGate
        session.pruneInfoGate = infoGate
        session.pruneFiber = Effect.runFork(onClock(session, session.volume.trashList()))
        await Effect.runPromise(Deferred.await(dataGate.entered))
        session.pruneDataGate = undefined
        await Effect.runPromise(Deferred.succeed(dataGate.reply, event.erased))
        if (event.erased) {
          await Effect.runPromise(Deferred.await(infoGate.entered))
          session.phase = "Expiring"
        } else {
          session.pruneInfoGate = undefined
          await Effect.runPromise(Fiber.await(session.pruneFiber))
          session.pruneFiber = undefined
        }
        return "accepted"
      }
      case "completePrune": {
        if (session.phase !== "Expiring") return "refused"
        let infoGate = session.pruneInfoGate
        if (infoGate === undefined) {
          infoGate = makeGate()
          session.pruneInfoGate = infoGate
          session.pruneFiber = Effect.runFork(onClock(session, session.volume.trashList()))
          await Effect.runPromise(Deferred.await(infoGate.entered))
        }
        session.pruneInfoGate = undefined
        await Effect.runPromise(Deferred.succeed(infoGate.reply, event.writeAcknowledged))
        if (session.pruneFiber !== undefined) await Effect.runPromise(Fiber.await(session.pruneFiber))
        session.pruneFiber = undefined
        if (event.writeAcknowledged) {
          session.phase = "Gone"
        }
        return "accepted"
      }
      default: {
        const unreachable: never = event
        return unreachable
      }
    }
  },
  observe(key): TrashRow {
    const session = sessionOf(key)
    const stored = readTrashRows(session)
    if (session.phase === "Visible") return { phase: "Visible", journal: false, resident: false, deletedAt: 0 }
    if (session.phase === "Gone") return { phase: "Gone", journal: stored.journal, resident: stored.resident, deletedAt: session.deletedAt }
    return {
      phase: session.phase,
      journal: stored.journal,
      resident: stored.resident,
      deletedAt: stored.row?.deletedAt ?? session.deletedAt,
    }
  },
}

export const options: Options<TrashRow> = { keys: ["trash"] }
