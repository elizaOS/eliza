// spec/localInference/speechOutput.md, "Story: Speak a reply without cutting off what is playing"; spec/localInference/speechOutput.md, "Story: Start streamed speech without needless connections"
import { Deferred, Effect, Fiber, ManagedRuntime } from "effect";
import type { Driver, Options } from "../../gen/localInference__speechOutput.conformance.ts";
import type { Bootstrap, Event, Playback, SpeechOutput } from "../../gen/localInference__speechOutput.ts";
import {
  SpeechOutputMachine,
  bootstrapStreamedSpeech,
  cancelReply,
  publishReply,
  speechOutput,
  type BootstrapRequest,
  type Connection,
  type PlaybackSlot,
  type Publication,
} from "../../src/index.vibe";

interface BootstrapNotice {
  readonly request: BootstrapRequest;
  readonly connection: Connection;
}

class OutputHarness {
  readonly runtime = ManagedRuntime.make(speechOutput());
  slotPlayback: Playback = "EmptyPlayback";
  playedCount = 0;
  pendingPrepare: Deferred.Deferred<string> | null = null;
  pendingPublish: Fiber.Fiber<Publication, never> | null = null;
  bootstrap: Bootstrap = {
    started: false,
    stage: 0,
    http1: false,
    keepAlive: false,
    connections: 0,
    pending: false,
    stopped: false,
  };
  bootstrapFiber: Fiber.Fiber<number, never> | null = null;
  nextNotice: Deferred.Deferred<BootstrapNotice> | null = null;
  completeGate: Deferred.Deferred<void> | null = null;

  private readonly slot: PlaybackSlot<string> = {
    current: () => Effect.sync(() => this.slotPlayback),
    play: () =>
      Effect.sync(() => {
        this.slotPlayback = "PreparedClip";
        this.playedCount += 1;
      }),
  };

  async send(event: Event): Promise<"accepted" | "refused"> {
    if (event.type === "admitSpeech") {
      if (this.pendingPublish !== null) {
        const res = await this.runtime.runPromise(
          publishReply(this.slot, Effect.succeed("busy"), { replace: event.replace }),
        );
        return res === "busy" ? "refused" : "accepted";
      }
      const admittedGate = await this.runtime.runPromise(Deferred.make<void>());
      const prepareGate = await this.runtime.runPromise(Deferred.make<string>());
      this.pendingPrepare = prepareGate;
      const program = publishReply(
        this.slot,
        Effect.gen(function* () {
          yield* Deferred.succeed(admittedGate, undefined);
          return yield* Deferred.await(prepareGate);
        }),
        { replace: event.replace },
      );
      this.pendingPublish = this.runtime.runFork(program);
      await this.runtime.runPromise(Deferred.await(admittedGate));
      return "accepted";
    }

    if (event.type === "changePlayback") {
      const current = await this.observe();
      if (
        current.publication.publishPhase !== "PublishIdle" &&
        current.publication.publishPhase !== "PublishAdmitted"
      ) {
        return "refused";
      }
      this.slotPlayback = event.kind;
      await this.runtime.runPromise(
        Effect.gen(function* () {
          const machine = yield* SpeechOutputMachine;
          yield* Effect.ignore(machine.send({ type: "changePlayback", kind: event.kind }));
        }),
      );
      return "accepted";
    }

    if (event.type === "cancelSpeech") {
      const current = await this.observe();
      await this.runtime.runPromise(cancelReply());
      return current.publication.publishPhase === "PublishAdmitted" ? "accepted" : "refused";
    }

    if (event.type === "publishSpeech") {
      if (this.pendingPrepare === null || this.pendingPublish === null) return "refused";
      const prepare = this.pendingPrepare;
      const fiber = this.pendingPublish;
      this.pendingPrepare = null;
      this.pendingPublish = null;
      await this.runtime.runPromise(Deferred.succeed(prepare, "clip"));
      await this.runtime.runPromise(Fiber.join(fiber));
      return "accepted";
    }

    if (event.type === "startBootstrap") {
      if (this.bootstrap.started) return "refused";
      this.bootstrap = {
        ...this.bootstrap,
        started: true,
        http1: event.http1,
        keepAlive: event.keepAlive,
      };
      return "accepted";
    }

    if (event.type === "sendBootstrapRequest") {
      const b = this.bootstrap;
      if (!b.started || b.stopped || b.stage >= 3 || b.pending) return "refused";
      if (this.bootstrapFiber === null) {
        const notice0 = await this.runtime.runPromise(Deferred.make<BootstrapNotice>());
        const complete0 = await this.runtime.runPromise(Deferred.make<void>());
        this.nextNotice = notice0;
        this.completeGate = complete0;
        const readState = () => ({ notice: this.nextNotice, gate: this.completeGate });
        const fiber = this.runtime.runFork(
          bootstrapStreamedSpeech(
            { http1: b.http1, keepAlive: b.keepAlive },
            (request, connection) =>
              Effect.gen(function* () {
                const { notice, gate } = readState();
                if (notice !== null) {
                  yield* Deferred.succeed(notice, { request, connection });
                }
                if (gate !== null) {
                  yield* Deferred.await(gate);
                }
              }),
          ),
        );
        this.bootstrapFiber = fiber;
      }
      const notice = this.nextNotice;
      if (notice === null) return "refused";
      const observed = await this.runtime.runPromise(Deferred.await(notice));
      this.bootstrap = {
        ...this.bootstrap,
        pending: true,
        connections: this.bootstrap.connections + (observed.connection === "open" ? 1 : 0),
      };
      return "accepted";
    }

    if (event.type === "completeBootstrapRequest") {
      const b = this.bootstrap;
      if (!b.pending || b.stopped || this.completeGate === null) return "refused";
      const gate = this.completeGate;
      if (b.stage + 1 < 3) {
        this.nextNotice = await this.runtime.runPromise(Deferred.make<BootstrapNotice>());
        this.completeGate = await this.runtime.runPromise(Deferred.make<void>());
      } else {
        this.nextNotice = null;
        this.completeGate = null;
      }
      await this.runtime.runPromise(Deferred.succeed(gate, undefined));
      this.bootstrap = {
        ...this.bootstrap,
        stage: b.stage + 1,
        pending: false,
      };
      if (this.bootstrap.stage === 3 && this.bootstrapFiber !== null) {
        await this.runtime.runPromise(Fiber.join(this.bootstrapFiber));
        this.bootstrapFiber = null;
      }
      return "accepted";
    }

    const b = this.bootstrap;
    if (!b.started || b.stage >= 3 || b.stopped) return "refused";
    if (this.bootstrapFiber !== null) {
      await this.runtime.runPromise(Fiber.interrupt(this.bootstrapFiber));
      this.bootstrapFiber = null;
    }
    this.nextNotice = null;
    this.completeGate = null;
    this.bootstrap = {
      ...this.bootstrap,
      pending: false,
      stopped: true,
    };
    return "accepted";
  }

  async observe(): Promise<SpeechOutput> {
    const state = await this.runtime.runPromise(
      Effect.gen(function* () {
        const machine = yield* SpeechOutputMachine;
        return yield* machine.get();
      }),
    );
    return {
      publication: state.publication,
      bootstrap: { ...this.bootstrap },
    };
  }

  async dispose(): Promise<void> {
    if (this.pendingPublish !== null) {
      await this.runtime.runPromise(Fiber.interrupt(this.pendingPublish));
      this.pendingPublish = null;
    }
    if (this.bootstrapFiber !== null) {
      await this.runtime.runPromise(Fiber.interrupt(this.bootstrapFiber));
      this.bootstrapFiber = null;
    }
    await this.runtime.dispose();
  }
}

const harnesses = new Map<string, OutputHarness>();

function harnessOf(key: string): OutputHarness {
  let existing = harnesses.get(key);
  if (existing === undefined) {
    existing = new OutputHarness();
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
    return harnessOf(key).send(event);
  },

  async observe(key: string): Promise<SpeechOutput> {
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
