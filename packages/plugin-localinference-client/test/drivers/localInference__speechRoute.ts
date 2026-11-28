// spec/localInference/speechRoute.md, "Story: Hear a reply on the admitted speech route"
import { Deferred, Effect, Fiber, Layer, ManagedRuntime } from "effect";
import { TestClock } from "effect/testing";
import type { Driver, Options } from "../../gen/localInference__speechRoute.conformance.ts";
import type { Event, SpeechFailure, SpeechRoute, SpeechRouting } from "../../gen/localInference__speechRoute.ts";
import {
  SpeechAttemptFailed,
  SpeechRoutingMachine,
  deviceSpeechUnavailable,
  nextSpeechRoute,
  speakOnRoute,
  speechKeyChanged,
  speechLimitChanged,
  speechRouting,
} from "../../src/index.vibe";

type AttemptCommand =
  | { readonly tag: "finish" }
  | { readonly tag: "fail"; readonly failure: SpeechFailure };

interface ActiveAttempt {
  readonly route: SpeechRoute;
  readonly heard: () => Effect.Effect<void, unknown>;
  readonly command: Deferred.Deferred<AttemptCommand>;
}

class RouteHarness {
  readonly runtime = ManagedRuntime.make(Layer.mergeAll(speechRouting(), TestClock.layer()));
  clockMs = 0;
  turnFiber: Fiber.Fiber<string, unknown> | null = null;
  activeAttempt: ActiveAttempt | null = null;
  nextAttemptGate: Deferred.Deferred<ActiveAttempt> | null = null;

  private async advanceClock(nowMs: number): Promise<void> {
    if (nowMs > this.clockMs) {
      this.clockMs = nowMs;
      await this.runtime.runPromise(TestClock.setTime(nowMs));
    }
  }

  async dispatch(event: Event): Promise<"accepted" | "refused"> {
    const before = await this.observe();

    if (event.type === "keyChanged") {
      const same = JSON.stringify(before.key) === JSON.stringify(event.key);
      await this.runtime.runPromise(speechKeyChanged(event.key));
      return same ? "refused" : "accepted";
    }

    if (event.type === "limitChanged") {
      const same = JSON.stringify(before.limit) === JSON.stringify(event.limit);
      await this.runtime.runPromise(speechLimitChanged(event.limit));
      return same ? "refused" : "accepted";
    }

    if (event.type === "holdLifted") {
      const hadHold = before.hold.tag !== "NoSpeechHold";
      await this.runtime.runPromise(deviceSpeechUnavailable());
      return hadHold ? "accepted" : "refused";
    }

    if (event.type === "beginTurn") {
      if (event.nowMs < 0) return "refused";
      if (before.turn.tag !== "Quiet") {
        await this.runtime.runPromise(
          Effect.ignore(speakOnRoute(() => Effect.succeed("busy"))),
        );
        return "refused";
      }
      await this.advanceClock(event.nowMs);
      await this.runtime.runPromise(nextSpeechRoute());
      const entered = await this.runtime.runPromise(Deferred.make<ActiveAttempt>());
      this.nextAttemptGate = entered;
      const registerSlot = (slot: ActiveAttempt) => {
        this.activeAttempt = slot;
        const gate = this.nextAttemptGate;
        this.nextAttemptGate = null;
        return gate;
      };
      this.turnFiber = this.runtime.runFork(
        speakOnRoute((route, heard) =>
          Effect.gen(function* () {
            const command = yield* Deferred.make<AttemptCommand>();
            const slot: ActiveAttempt = { route, heard, command };
            const gate = registerSlot(slot);
            if (gate !== null) {
              yield* Deferred.succeed(gate, slot);
            }
            const next = yield* Deferred.await(command);
            if (next.tag === "fail") {
              return yield* Effect.fail(new SpeechAttemptFailed({ failure: next.failure, cause: null }));
            }
            return "spoken";
          }),
        ),
      );
      await this.runtime.runPromise(Deferred.await(entered));
      return "accepted";
    }

    if (event.type === "audioStarted") {
      if (before.turn.tag !== "Speaking" || before.turn.audible) return "refused";
      if (before.turn.route !== event.route) {
        await this.runtime.runPromise(
          Effect.gen(function* () {
            const machine = yield* SpeechRoutingMachine;
            yield* Effect.ignore(machine.send({ type: "audioStarted", route: event.route }));
          }),
        );
        return "refused";
      }
      const current = this.activeAttempt;
      if (current === null) return "refused";
      await this.runtime.runPromise(Effect.ignore(current.heard()));
      return "accepted";
    }

    if (event.type === "networkFailed") {
      if (
        before.turn.tag !== "Speaking" ||
        before.turn.route === "DeviceRoute" ||
        before.turn.audible ||
        event.nowMs < 0
      ) {
        return "refused";
      }
      const current = this.activeAttempt;
      const fiber = this.turnFiber;
      if (current === null || fiber === null) return "refused";
      await this.advanceClock(event.nowMs);
      const willFallback =
        event.failure.tag !== "NoSpeech" &&
        event.failure.tag !== "CleanupUnconfirmed" &&
        event.failure.tag !== "RequestRefused";
      if (willFallback) {
        const fallbackEntered = await this.runtime.runPromise(Deferred.make<ActiveAttempt>());
        this.nextAttemptGate = fallbackEntered;
        await this.runtime.runPromise(
          Deferred.succeed(current.command, { tag: "fail", failure: event.failure }),
        );
        await this.runtime.runPromise(Deferred.await(fallbackEntered));
      } else {
        this.activeAttempt = null;
        this.turnFiber = null;
        await this.runtime.runPromise(
          Deferred.succeed(current.command, { tag: "fail", failure: event.failure }),
        );
        await this.runtime.runPromise(Effect.ignore(Fiber.join(fiber)));
      }
      return "accepted";
    }

    if (event.type === "speechFinished") {
      if (before.turn.tag !== "Speaking" || !before.turn.audible) return "refused";
      const current = this.activeAttempt;
      const fiber = this.turnFiber;
      if (current === null || fiber === null) return "refused";
      this.activeAttempt = null;
      this.turnFiber = null;
      await this.runtime.runPromise(Deferred.succeed(current.command, { tag: "finish" }));
      await this.runtime.runPromise(Effect.ignore(Fiber.join(fiber)));
      return "accepted";
    }

    if (event.type === "speechFailed") {
      if (
        before.turn.tag !== "Speaking" ||
        (!before.turn.audible && before.turn.route !== "DeviceRoute")
      ) {
        return "refused";
      }
      const current = this.activeAttempt;
      const fiber = this.turnFiber;
      if (current === null || fiber === null) return "refused";
      this.activeAttempt = null;
      this.turnFiber = null;
      await this.runtime.runPromise(
        Deferred.succeed(current.command, { tag: "fail", failure: { tag: "Offline" } }),
      );
      await this.runtime.runPromise(Effect.ignore(Fiber.join(fiber)));
      return "accepted";
    }

    if (before.turn.tag !== "Speaking" || this.turnFiber === null) return "refused";
    const fiber = this.turnFiber;
    this.activeAttempt = null;
    this.turnFiber = null;
    await this.runtime.runPromise(Fiber.interrupt(fiber));
    return "accepted";
  }

  async observe(): Promise<SpeechRouting> {
    return this.runtime.runPromise(
      Effect.gen(function* () {
        const machine = yield* SpeechRoutingMachine;
        return yield* machine.get();
      }),
    );
  }

  async dispose(): Promise<void> {
    if (this.turnFiber !== null) {
      await this.runtime.runPromise(Fiber.interrupt(this.turnFiber));
      this.turnFiber = null;
    }
    await this.runtime.dispose();
  }
}

const harnesses = new Map<string, RouteHarness>();

function harnessOf(key: string): RouteHarness {
  let existing = harnesses.get(key);
  if (existing === undefined) {
    existing = new RouteHarness();
    harnesses.set(key, existing);
  }
  return existing;
}

export const driver: Driver & AsyncDisposable = {
  async reset() {
    for (const h of harnesses.values()) {
      await h.dispose();
    }
    harnesses.clear();
  },

  async dispatch(key: string, event: Event) {
    return harnessOf(key).dispatch(event);
  },

  async observe(key: string): Promise<SpeechRouting> {
    return harnessOf(key).observe();
  },

  async [Symbol.asyncDispose]() {
    for (const h of harnesses.values()) {
      await h.dispose();
    }
    harnesses.clear();
  },
};

export const options: Options = { keys: ["a", "b"], walks: 25, steps: 25 };
