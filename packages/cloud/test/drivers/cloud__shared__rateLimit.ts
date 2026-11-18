// spec/cloud/shared/rateLimit.md, "Story: Refuse excess requests with a usable retry time"; spec/cloud/shared/rateLimit.md, "Story: Refuse rather than guess when the limiter cannot count"
import { Clock, Effect, Exit, ManagedRuntime } from "effect";
import type { Driver, Options } from "../../gen/cloud__shared__rateLimit.conformance.ts";
import type { Window } from "../../gen/cloud__shared__rateLimit.ts";
import { Refused } from "../../src/http/refusal.vibe";
import { admitCheck, readWindow, type RateLimit } from "../../src/shared/rate-limit.vibe";
import { Store, migrate, storeLayer } from "../../src/store/store.vibe";
import { manualClock } from "../support/clock.ts";

const initialWindow: Window = { start: 0, end: 0, count: 0, ceiling: 0, clock: 0, last: { tag: "NoDecision" } };

let runtime: ManagedRuntime.ManagedRuntime<Store, unknown> | undefined;
const names = new Map<string, string>();
const time = manualClock();

async function store() {
  if (runtime === undefined) {
    runtime = ManagedRuntime.make(storeLayer({ kind: "pglite", file: undefined }));
    await runtime.runPromise(migrate({ digest: "0".repeat(64), environment: "staging", now: 0 }));
  }
  return runtime;
}

function check(subject: string, rule: RateLimit) {
  return { subject, rule };
}

export const driver: Driver = {
  async reset() {
    names.clear();
    const opened = await store();
    await opened.runPromise(Effect.gen(function* () {
      const kept = yield* Store;
      yield* kept.transaction((tx) => tx.query("DELETE FROM rate_windows"));
    }));
  },
  async dispatch(key, event) {
    names.set(key, event.rule.name);
    const opened = await store();
    time.set(event.now);
    const exit = await opened.runPromise(Effect.exit(Effect.provideService(admitCheck(check(key, event.rule)), Clock.Clock, time.clock)));
    if (Exit.isSuccess(exit)) return "accepted";
    const failure = Exit.findErrorOption(exit);
    if (failure._tag === "Some" && failure.value instanceof Refused) {
      if (failure.value.refusal.code === "RateLimited") return "accepted";
      if (failure.value.refusal.code === "RateLimitUnavailable") return "refused";
    }
    throw new Error(`the limiter failed: ${String(exit)}`);
  },
  async observe(key) {
    const name = names.get(key);
    if (name === undefined) return initialWindow;
    const opened = await store();
    return await opened.runPromise(readWindow(check(key, { name, limit: 1, windowMs: 1 })));
  },
};

export const options: Options = { keys: ["203.0.113.7", "198.51.100.9"], walks: 20, steps: 25 };
