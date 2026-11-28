// spec/files/requests.md, "Story: Open the file I asked for, and only from what I was shown"
import { Deferred, Effect, Fiber } from "effect";
import type { Driver, Options } from "../../gen/files__requests.conformance.ts";
import type { OpenOutcome, OpenPorts } from "@elizaos/plugin-files-client";
import type { FileRequest as SpecFileRequest, RequestPhase } from "../../gen/files__requests.ts";
import { filesView } from "@elizaos/plugin-files-client";

type View = Pick<SpecFileRequest, "phase" | "active" | "cancelled" | "opened" | "released" | "grantDelivered">;
const view = ({ phase, active, cancelled, opened, released, grantDelivered }: SpecFileRequest): View => ({
  phase,
  active,
  cancelled,
  opened,
  released,
  grantDelivered,
});

interface Gate {
  readonly entered: Deferred.Deferred<void>;
  readonly reply: Deferred.Deferred<boolean>;
}

interface Session {
  readonly files: Effect.Success<ReturnType<typeof filesView>>;
  active: boolean;
  phase: RequestPhase;
  cancelled: boolean;
  opened: boolean;
  released: boolean;
  grantDelivered: boolean;
  load: "Unread" | "Loading" | "Loaded" | "LoadFailed";
  commitGate: Gate | undefined;
  accessGate: Gate | undefined;
  selectGate: Gate | undefined;
  fiber: Fiber.Fiber<OpenOutcome> | undefined;
}

const sessions = new Map<string, Session>();

function makeGate(): Gate {
  return {
    entered: Effect.runSync(Deferred.make<void>()),
    reply: Effect.runSync(Deferred.make<boolean>()),
  };
}

function sessionOf(key: string): Session {
  const existing = sessions.get(key);
  if (existing !== undefined) return existing;
  const created: Session = {
    files: Effect.runSync(filesView()),
    active: false,
    phase: "RequestIdle",
    cancelled: false,
    opened: false,
    released: false,
    grantDelivered: false,
    load: "Unread",
    commitGate: undefined,
    accessGate: undefined,
    selectGate: undefined,
    fiber: undefined,
  };
  sessions.set(key, created);
  return created;
}

function isPending(phase: RequestPhase): boolean {
  return phase === "AwaitingView" || phase === "AwaitingAccess" || phase === "AwaitingSelection";
}

async function settleIfDone(session: Session): Promise<void> {
  if (session.fiber === undefined) return;
  const outcome = await Effect.runPromise(Fiber.join(session.fiber));
  session.fiber = undefined;
  if (outcome.kind === "opened") {
    session.phase = "FileOpened";
    session.opened = true;
  } else {
    session.phase = "RequestRefused";
  }
}

export const driver: Driver<View> = {
  reset() {
    sessions.clear();
  },
  async dispatch(key, event) {
    const session = sessionOf(key);
    switch (event.type) {
      case "beginRequest": {
        if (session.phase !== "RequestIdle") return "refused";
        const commitGate = makeGate();
        const accessGate = makeGate();
        const selectGate = makeGate();
        session.commitGate = commitGate;
        session.accessGate = accessGate;
        session.selectGate = selectGate;
        const ports: OpenPorts = {
          commitView: () => Effect.gen(function* () {
            yield* Deferred.succeed(commitGate.entered, undefined);
            return yield* Deferred.await(commitGate.reply);
          }),
          access: () => Effect.gen(function* () {
            yield* Deferred.succeed(accessGate.entered, undefined);
            return yield* Deferred.await(accessGate.reply);
          }),
          select: () => Effect.gen(function* () {
            yield* Deferred.succeed(selectGate.entered, undefined);
            return yield* Deferred.await(selectGate.reply);
          }),
          release: () => Effect.sync(() => {
            session.released = true;
          }),
        };
        session.fiber = Effect.runFork(session.files.open({ path: "Download/report.pdf" }, ports));
        if (session.active) {
          await Effect.runPromise(Deferred.await(accessGate.entered));
          session.phase = "AwaitingAccess";
        } else {
          await Effect.runPromise(Deferred.await(commitGate.entered));
          session.phase = "AwaitingView";
        }
        return "accepted";
      }
      case "commitView": {
        if (session.phase !== "AwaitingView" || session.commitGate === undefined || session.accessGate === undefined) return "refused";
        const gate = session.commitGate;
        const accessGate = session.accessGate;
        session.commitGate = undefined;
        await Effect.runPromise(Deferred.succeed(gate.reply, event.confirmed));
        const raced = await Effect.runPromise(
          Effect.raceFirst(
            Deferred.await(accessGate.entered).pipe(Effect.as("access" as const)),
            session.fiber === undefined ? Effect.succeed("done" as const) : Fiber.await(session.fiber).pipe(Effect.as("done" as const)),
          ),
        );
        if (raced === "access") {
          session.active = true;
          session.load = "Loading";
          session.phase = "AwaitingAccess";
        } else {
          await settleIfDone(session);
        }
        return "accepted";
      }
      case "accessReply": {
        if (session.phase !== "AwaitingAccess" || session.accessGate === undefined || session.selectGate === undefined) return "refused";
        const gate = session.accessGate;
        const selectGate = session.selectGate;
        session.accessGate = undefined;
        await Effect.runPromise(Deferred.succeed(gate.reply, event.granted));
        if (event.granted && session.active && !session.cancelled) {
          const raced = await Effect.runPromise(
            Effect.raceFirst(
              Deferred.await(selectGate.entered).pipe(Effect.as("selection" as const)),
              session.fiber === undefined ? Effect.succeed("done" as const) : Fiber.await(session.fiber).pipe(Effect.as("done" as const)),
            ),
          );
          if (raced === "selection") {
            session.phase = "AwaitingSelection";
          } else {
            await settleIfDone(session);
          }
        } else {
          await settleIfDone(session);
        }
        return "accepted";
      }
      case "selectionReply": {
        if (session.phase !== "AwaitingSelection" || session.selectGate === undefined) return "refused";
        const gate = session.selectGate;
        session.selectGate = undefined;
        session.grantDelivered = event.granted;
        await Effect.runPromise(Deferred.succeed(gate.reply, event.granted));
        await settleIfDone(session);
        return "accepted";
      }
      case "cancelRequest": {
        if (!isPending(session.phase) || session.cancelled) return "refused";
        session.cancelled = true;
        await Effect.runPromise(session.files.cancel());
        return "accepted";
      }
      case "enterFiles": {
        const ok = await Effect.runPromise(session.files.enter());
        if (!ok) return "refused";
        session.active = true;
        session.load = "Loading";
        return "accepted";
      }
      case "leaveFiles": {
        const ok = await Effect.runPromise(session.files.leave());
        if (!ok) return "refused";
        session.active = false;
        return "accepted";
      }
      case "replaceRows": {
        const shown = await Effect.runPromise(session.files.show({}, { entries: [], complete: true, empty: true }));
        return shown === undefined ? "refused" : "accepted";
      }
      case "loadReply": {
        const ok = await Effect.runPromise(session.files.loaded(event.success));
        if (!ok) return "refused";
        session.load = event.success ? "Loaded" : "LoadFailed";
        return "accepted";
      }
      default: {
        const unreachable: never = event;
        return unreachable;
      }
    }
  },
  observe: (key): View => {
    const session = sessionOf(key);
    return {
      phase: session.phase,
      active: session.active,
      cancelled: session.cancelled,
      opened: session.opened,
      released: session.released,
      grantDelivered: session.grantDelivered,
    };
  },
};

export const options: Options<View> = { view, keys: ["files"] };
