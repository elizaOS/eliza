// spec/files/reviewedOperations.md, "Story: Act only on the file revision I reviewed"
import { mkdtempSync, rmSync, writeFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Clock, Deferred, Effect, Fiber, FileSystem, Layer, PlatformError } from "effect";
import { NodeFileSystem, NodePath } from "@effect/platform-node";
import type { Driver, Options } from "../../gen/files__reviewedOperations.conformance.ts";
import type { TrashPhase, TrashRow } from "../../gen/files__reviewedOperations.ts";
import { FilesVolume, TRASH } from "@elizaos/plugin-files-client";
import { localVolume } from "@elizaos/plugin-files";

const EXPIRY_MS = 2_592_000_000;

interface Gate {
  readonly entered: Deferred.Deferred<void>;
  readonly reply: Deferred.Deferred<boolean>;
}

interface Session {
  readonly root: string;
  readonly volume: FilesVolume.Shape;
  readonly clock: Clock.Clock;
  now: number;
  phase: TrashPhase;
  deletedAt: number;
  trashId: string | undefined;
  moveGate: Gate | undefined;
  undoGate: Gate | undefined;
  pruneDataGate: Gate | undefined;
  pruneInfoGate: Gate | undefined;
  trashFiber: Fiber.Fiber<unknown, unknown> | undefined;
  pruneFiber: Fiber.Fiber<unknown, unknown> | undefined;
}

const sessions = new Map<string, Session>();

function makeGate(): Gate {
  return {
    entered: Effect.runSync(Deferred.make<void>()),
    reply: Effect.runSync(Deferred.make<boolean>()),
  };
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
  };
}

function makeSession(key: string): Session {
  const root = mkdtempSync(join(tmpdir(), "files-revops-"));
  const state = {
    root,
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
  };
  const clock = makeClock(state);
  const baseFs = Effect.runSync(Effect.provide(FileSystem.FileSystem, NodeFileSystem.layer));
  const fsError = (path: string) =>
    Effect.fail(
      PlatformError.systemError({
        _tag: "Unknown",
        module: "FileSystem",
        method: "remove",
        pathOrDescriptor: path,
        description: "injected failure",
      }),
    );

  const gatedFs: FileSystem.FileSystem = {
    ...baseFs,
    rename(from, to) {
      if (to.includes(`${TRASH}/files/`) && state.moveGate !== undefined) {
        const gate = state.moveGate;
        return Effect.gen(function* () {
          yield* Deferred.succeed(gate.entered, undefined);
          const ok = yield* Deferred.await(gate.reply);
          if (!ok) return yield* fsError(to);
          return yield* baseFs.rename(from, to);
        });
      }
      return baseFs.rename(from, to);
    },
    remove(target, options) {
      if (target.includes(`${TRASH}/info/`) && state.undoGate !== undefined) {
        const gate = state.undoGate;
        return Effect.gen(function* () {
          yield* Deferred.succeed(gate.entered, undefined);
          yield* Deferred.await(gate.reply);
          return yield* baseFs.remove(target, options);
        });
      }
      if (target.includes(`${TRASH}/files/`) && state.pruneDataGate !== undefined) {
        const gate = state.pruneDataGate;
        return Effect.gen(function* () {
          yield* Deferred.succeed(gate.entered, undefined);
          const ok = yield* Deferred.await(gate.reply);
          if (!ok) return yield* fsError(target);
          return yield* baseFs.remove(target, options);
        });
      }
      if (target.includes(`${TRASH}/info/`) && state.pruneInfoGate !== undefined) {
        const gate = state.pruneInfoGate;
        return Effect.gen(function* () {
          yield* Deferred.succeed(gate.entered, undefined);
          const ok = yield* Deferred.await(gate.reply);
          if (!ok) return yield* fsError(target);
          return yield* baseFs.remove(target, options);
        });
      }
      return baseFs.remove(target, options);
    },
  };

  const layer = localVolume(root).pipe(
    Layer.provide(Layer.succeed(FileSystem.FileSystem, gatedFs)),
    Layer.provide(NodePath.layer),
  );
  const volume = Effect.runSync(Effect.provide(FilesVolume, layer));
  const session: Session = Object.assign(state, { volume, clock });
  sessions.set(key, session);
  return session;
}

function sessionOf(key: string): Session {
  return sessions.get(key) ?? makeSession(key);
}

function onClock<A, E>(session: Session, eff: Effect.Effect<A, E>): Effect.Effect<A, E> {
  return Effect.provideService(eff, Clock.Clock, session.clock);
}

function readTrashFiles(session: Session): { readonly journal: boolean; readonly resident: boolean; readonly row?: TrashRow } {
  const infoDir = join(session.root, TRASH, "info");
  const filesDir = join(session.root, TRASH, "files");
  const infos = existsSync(infoDir) ? readdirSync(infoDir).filter((name) => name.endsWith(".json")) : [];
  const id = session.trashId ?? infos[0]?.slice(0, -".json".length);
  if (id === undefined) return { journal: false, resident: false };
  const infoPath = join(infoDir, `${id}.json`);
  const dataPath = join(filesDir, id);
  const journal = existsSync(infoPath);
  const resident = existsSync(dataPath);
  if (!journal) return { journal, resident };
  try {
    const parsed = JSON.parse(readFileSync(infoPath, "utf8")) as { row?: TrashRow };
    return { journal, resident, row: parsed.row };
  } catch {
    return { journal, resident };
  }
}

function isAdmittedTrash(op: string, row: {
  readonly validPath: boolean;
  readonly pathExists: boolean;
  readonly reviewRequired: boolean;
  readonly reviewMatches: boolean;
  readonly currentOwner: boolean;
  readonly sameFolder: boolean;
  readonly descendant: boolean;
}): boolean {
  if (op !== "Trash") return false;
  if (!row.validPath || !row.currentOwner || !row.pathExists) return false;
  return !row.reviewRequired || row.reviewMatches;
}

export const driver: Driver<TrashRow> = {
  reset() {
    for (const session of sessions.values()) rmSync(session.root, { recursive: true, force: true });
    sessions.clear();
  },
  async dispatch(key, event) {
    const session = sessionOf(key);
    switch (event.type) {
      case "journal": {
        if (session.phase !== "Visible" || event.at < 0 || !isAdmittedTrash(event.op, event.row)) return "refused";
        const target = join(session.root, "note.txt");
        writeFileSync(target, "data");
        session.now = event.at;
        session.deletedAt = event.at;
        const moveGate = makeGate();
        const undoGate = makeGate();
        session.moveGate = moveGate;
        session.undoGate = undoGate;
        const tokens = event.row.reviewRequired
          ? await Effect.runPromise(onClock(session, session.volume.reviewedIdentities(["note.txt"])))
          : undefined;
        session.trashFiber = Effect.runFork(
          onClock(session, session.volume.trash({ paths: ["note.txt"], ...(tokens === undefined ? {} : { reviewed: tokens }) })),
        );
        await Effect.runPromise(Deferred.await(moveGate.entered));
        const infoDir = join(session.root, TRASH, "info");
        const infos = existsSync(infoDir) ? readdirSync(infoDir).filter((name) => name.endsWith(".json")) : [];
        session.trashId = infos[0]?.slice(0, -".json".length);
        session.phase = "Journaled";
        return "accepted";
      }
      case "moveToTrash": {
        if (session.phase !== "Journaled" || session.moveGate === undefined || session.undoGate === undefined) return "refused";
        const moveGate = session.moveGate;
        const undoGate = session.undoGate;
        session.moveGate = undefined;
        await Effect.runPromise(Deferred.succeed(moveGate.reply, event.acknowledged));
        if (event.acknowledged) {
          session.undoGate = undefined;
          if (session.trashFiber !== undefined) await Effect.runPromise(Fiber.await(session.trashFiber));
          session.trashFiber = undefined;
          session.phase = "InTrash";
        } else {
          await Effect.runPromise(Deferred.await(undoGate.entered));
          session.phase = "MoveFailed";
        }
        return "accepted";
      }
      case "undoFailedJournal": {
        if (session.phase !== "MoveFailed" || session.undoGate === undefined) return "refused";
        const undoGate = session.undoGate;
        session.undoGate = undefined;
        await Effect.runPromise(Deferred.succeed(undoGate.reply, true));
        if (session.trashFiber !== undefined) await Effect.runPromise(Fiber.await(session.trashFiber));
        session.trashFiber = undefined;
        session.trashId = undefined;
        session.deletedAt = 0;
        session.phase = "Visible";
        return "accepted";
      }
      case "prune": {
        if (session.phase !== "InTrash" || event.at - session.deletedAt < EXPIRY_MS) return "refused";
        session.now = event.at;
        const dataGate = makeGate();
        const infoGate = makeGate();
        session.pruneDataGate = dataGate;
        session.pruneInfoGate = infoGate;
        session.pruneFiber = Effect.runFork(onClock(session, session.volume.trashList()));
        await Effect.runPromise(Deferred.await(dataGate.entered));
        session.pruneDataGate = undefined;
        await Effect.runPromise(Deferred.succeed(dataGate.reply, event.erased));
        if (event.erased) {
          await Effect.runPromise(Deferred.await(infoGate.entered));
          session.phase = "Expiring";
        } else {
          session.pruneInfoGate = undefined;
          await Effect.runPromise(Fiber.await(session.pruneFiber));
          session.pruneFiber = undefined;
        }
        return "accepted";
      }
      case "completePrune": {
        if (session.phase !== "Expiring" || session.pruneInfoGate === undefined) return "refused";
        const infoGate = session.pruneInfoGate;
        session.pruneInfoGate = undefined;
        await Effect.runPromise(Deferred.succeed(infoGate.reply, event.writeAcknowledged));
        if (session.pruneFiber !== undefined) await Effect.runPromise(Fiber.await(session.pruneFiber));
        session.pruneFiber = undefined;
        if (event.writeAcknowledged) {
          session.phase = "Gone";
        } else {
          const retryInfoGate = makeGate();
          session.pruneInfoGate = retryInfoGate;
        }
        return "accepted";
      }
      default: {
        const unreachable: never = event;
        return unreachable;
      }
    }
  },
  observe(key): TrashRow {
    const session = sessionOf(key);
    const disk = readTrashFiles(session);
    if (session.phase === "Visible") return { phase: "Visible", journal: false, resident: false, deletedAt: 0 };
    if (session.phase === "Gone") return { phase: "Gone", journal: disk.journal, resident: disk.resident, deletedAt: session.deletedAt };
    return {
      phase: session.phase,
      journal: disk.journal,
      resident: disk.resident,
      deletedAt: disk.row?.deletedAt ?? session.deletedAt,
    };
  },
};

export const options: Options<TrashRow> = { keys: ["trash"] };
