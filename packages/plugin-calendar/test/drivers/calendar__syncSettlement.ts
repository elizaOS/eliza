// spec/calendar/syncSettlement.md, "Every attempt is in flight, recorded or ignored, and only one of them"; spec/calendar/syncSettlement.md, "A foreground read of the opt-in has exactly one outcome"
import { Deferred, Effect, Fiber } from "effect";
import type { Driver, Options } from "../../gen/calendar__syncSettlement.conformance.ts";
import type { Event, ForegroundSync, SyncSettlement } from "../../gen/calendar__syncSettlement.ts";
import { calendarWatchChannel, foregroundSyncMachine, type CalendarWatchAttemptOutcome, type CalendarWatchChannel } from "../../src/linked-sync/index.vibe";
import { memoryCalendarLinkStorage } from "../support/calendar-link-storage.ts";

interface Observed {
  readonly watch: CalendarWatchChannel;
  readonly foreground: ForegroundSync;
}

type Channel = Effect.Success<ReturnType<typeof calendarWatchChannel>>;
type Foreground = Effect.Success<ReturnType<typeof foregroundSyncMachine>>;
interface Running {
  readonly answer: Deferred.Deferred<boolean>;
  readonly fiber: Fiber.Fiber<CalendarWatchAttemptOutcome, unknown>;
}

const leaseMs = 1000;
let now = 0;
let expired = false;
let channel: Channel | undefined;
let foreground: Foreground | undefined;
const running = new Map<number, Running>();

const storage = memoryCalendarLinkStorage();

const run = <A>(effect: Effect.Effect<A, unknown>) => Effect.runPromise(effect);

async function claim(): Promise<"accepted" | "refused"> {
  const started = await run(Deferred.make<number>());
  const answer = await run(Deferred.make<boolean>());
  const fiber = await run(Effect.forkDetach(channel!.runAttempt((attempt) => Effect.gen(function* () {
    yield* Deferred.succeed(started, attempt);
    if (!(yield* Deferred.await(answer))) return yield* Effect.fail("attempt failed");
    return "synced";
  }))));
  const first = await run(Effect.raceFirst(Deferred.await(started), Fiber.join(fiber).pipe(Effect.as(0))));
  if (first === 0) return "refused";
  running.set(first, { answer, fiber });
  expired = false;
  return "accepted";
}

async function settle(attempt: number, succeeded: boolean): Promise<"accepted" | "refused"> {
  const held = running.get(attempt);
  if (held === undefined) return "refused";
  running.delete(attempt);
  await run(Deferred.succeed(held.answer, succeeded));
  await run(Fiber.join(held.fiber));
  return "accepted";
}

async function watchStep(event: Event): Promise<"accepted" | "refused"> {
  const before = await run(channel!.read());
  switch (event.type) {
    case "queueChange":
      if (before.channel !== "ChannelActive") return "refused";
      await run(channel!.queueChange());
      return "accepted";
    case "claimAttempt":
      return claim();
    case "expireLease":
      if (before.lease === 0 || expired) return "refused";
      now += leaseMs;
      expired = true;
      return "accepted";
    case "beginStop":
      if (before.channel !== "ChannelActive") return "refused";
      await run(channel!.beginStop());
      return "accepted";
    case "confirmStop":
      if (before.channel !== "ChannelStopping") return "refused";
      await run(channel!.confirmStop());
      expired = false;
      return "accepted";
    case "failAttempt":
      return settle(event.attempt, false);
    case "settleAttempt":
      return settle(event.attempt, true);
    default:
      return run(foreground!.send(event).pipe(Effect.as("accepted" as const), Effect.catch(() => Effect.succeed("refused" as const))));
  }
}

export const driver: Driver<Observed> = {
  async reset() {
    for (const held of running.values()) await run(Fiber.interrupt(held.fiber));
    running.clear();
    storage.reset();
    now = 0;
    expired = false;
    channel = await run(calendarWatchChannel({ storage, channelId: "watch", leaseMs, now: () => now }));
    foreground = await run(foregroundSyncMachine());
  },
  dispatch: (_key, event) => watchStep(event),
  async observe() {
    return { watch: await run(channel!.read()), foreground: (await run(foreground!.get())).foreground };
  },
};

export const options: Options<Observed> = {
  keys: ["channel"],
  view: (state: SyncSettlement) => {
    const { channel: phase, lease, pending, last, failures } = state.watch;
    return { watch: { channel: phase, lease, pending, last, failures }, foreground: state.foreground };
  },
};
