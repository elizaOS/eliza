// spec/blocker/index.md, "Story: Block distractions for a chosen interval"; spec/blocker/index.md, "Observations and expiry callbacks only affect the matching generation"
import { Effect, Layer, Option } from "effect";
import * as KeyValueStore from "effect/persistence/KeyValueStore";
import { TestClock } from "effect/testing";
import type { Driver, Options } from "../../gen/blocker.conformance.ts";
import type { Event, FocusBlock } from "../../gen/blocker.ts";
import {
  FocusBackend,
  FocusBackendFailed,
  clearFocus,
  enableFocus,
  reconcileFocus,
} from "../../src/index.vibe";

interface EntitySlot {
  rawState: string | undefined;
  readResult: boolean;
}

const slots = new Map<string, EntitySlot>();

function initialBlock(): FocusBlock {
  return {
    phase: "BlockIdle",
    ownerId: "",
    blockKind: "WebsiteBlock",
    targets: [],
    generation: 0,
    expiry: 0,
  };
}

function slotOf(key: string): EntitySlot {
  let slot = slots.get(key);
  if (!slot) {
    slot = { rawState: undefined, readResult: false };
    slots.set(key, slot);
  }
  return slot;
}

function readSlotState(slot: EntitySlot): FocusBlock {
  if (slot.rawState === undefined) return initialBlock();
  return JSON.parse(slot.rawState) as FocusBlock;
}

function makeKvLayer(slot: EntitySlot) {
  return Layer.succeed(
    KeyValueStore.KeyValueStore,
    KeyValueStore.make({
      get: () => Effect.succeed(slot.rawState),
      getUint8Array: () => Effect.succeed(undefined),
      set: (_k, value) => Effect.sync(() => {
        slot.rawState = typeof value === "string" ? value : new TextDecoder().decode(value);
      }),
      remove: () => Effect.sync(() => { slot.rawState = undefined; }),
      clear: Effect.sync(() => { slot.rawState = undefined; }),
      keys: Effect.sync(() => (slot.rawState === undefined ? [] : ["focus"])),
      size: Effect.sync(() => (slot.rawState === undefined ? 0 : 1)),
    }),
  );
}

function makeBackendLayer(slot: EntitySlot) {
  return Layer.succeed(FocusBackend, {
    apply: () => Effect.fail(new FocusBackendFailed({ operation: "apply", reason: "awaiting device observation" })),
    read: () => Effect.succeed(slot.readResult),
    clear: () => Effect.fail(new FocusBackendFailed({ operation: "clear", reason: "awaiting device observation" })),
    installedApps: () => Effect.succeed([]),
  });
}

async function runWithClock<A, E>(
  slot: EntitySlot,
  nowMs: number,
  program: Effect.Effect<A, E, FocusBackend | KeyValueStore.KeyValueStore>,
): Promise<{ readonly ok: true; readonly value: A } | { readonly ok: false; readonly error: E }> {
  const combined = Layer.mergeAll(makeKvLayer(slot), makeBackendLayer(slot), TestClock.layer());
  const timed = Effect.gen(function* () {
    yield* TestClock.setTime(nowMs);
    return yield* program;
  });
  return Effect.runPromise(
    Effect.match(Effect.provide(timed, combined), {
      onFailure: (error) => ({ ok: false as const, error }),
      onSuccess: (value) => ({ ok: true as const, value }),
    }),
  );
}

export const driver: Driver & AsyncDisposable = {
  reset() {
    slots.clear();
  },

  async dispatch(key: string, event: Event, by?: unknown) {
    const slot = slotOf(key);
    const current = readSlotState(slot);

    if (event.type === "requestBlock") {
      if (typeof by !== "string" || by !== event.ownerId) return "refused";
      if (event.ownerId === "" || event.ownerId === "device" || event.ownerId === "scheduler") return "refused";
      const before = slot.rawState;
      const result = await runWithClock(
        slot,
        event.now,
        enableFocus({
          ownerId: event.ownerId,
          blockKind: event.blockKind,
          targets: event.targets,
          deadline: event.deadline,
        }),
      );
      if (result.ok) return "accepted";
      const after = readSlotState(slot);
      if (slot.rawState !== before && after.phase === "ApplyingBlock") return "accepted";
      return "refused";
    }

    if (event.type === "observeApplied") {
      if (by !== "device" || current.phase !== "ApplyingBlock" || event.generation !== current.generation) {
        return "refused";
      }
      slot.readResult = event.applied;
      const result = await runWithClock(slot, 0, reconcileFocus(current.ownerId, current.blockKind));
      return result.ok ? "accepted" : "refused";
    }

    if (event.type === "requestClear") {
      if (typeof by !== "string" || current.phase !== "Blocking" || event.generation !== current.generation) {
        return "refused";
      }
      if (by !== current.ownerId && by !== "scheduler") return "refused";
      const before = slot.rawState;
      const result = await runWithClock(
        slot,
        event.now,
        clearFocus(current.ownerId, current.blockKind, event.generation, by === "scheduler"),
      );
      if (result.ok) return "accepted";
      const after = readSlotState(slot);
      if (slot.rawState !== before && after.phase === "ClearingBlock") return "accepted";
      return "refused";
    }

    if (event.type === "observeCleared") {
      if (by !== "device" || current.phase !== "ClearingBlock" || event.generation !== current.generation) {
        return "refused";
      }
      slot.readResult = !event.cleared;
      const result = await runWithClock(slot, 0, reconcileFocus(current.ownerId, current.blockKind));
      return result.ok ? "accepted" : "refused";
    }

    const _unused: Option.Option<never> = Option.none();
    void _unused;
    return "refused";
  },

  observe(key: string): FocusBlock {
    return readSlotState(slotOf(key));
  },

  [Symbol.asyncDispose]() {
    slots.clear();
    return Promise.resolve();
  },
};

export const options: Options = { keys: ["a", "b"], walks: 20, steps: 20 };
