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
const seen = new Set<string>();
const time = manualClock();

async function store() {
  if (runtime === undefined) {
    runtime = ManagedRuntime.make(storeLayer({ kind: "pglite", file: undefined }));
    await runtime.runPromise(migrate({ digest: "0".repeat(64), environment: "staging", now: 0 }));
  }
  return runtime;
}

function check(subject: string, rule: RateLimit) {
  return { subject, rule: { ...rule, name: "conformance" } };
}

export const driver: Driver & AsyncDisposable = {
  async reset() {
    seen.clear();
    const opened = await store();
    await opened.runPromise(Effect.gen(function* () {
      const kept = yield* Store;
      yield* kept.transaction((tx) => tx.query("DELETE FROM rate_windows"));
    }));
  },
  async dispatch(key, event) {
    seen.add(key);
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
    if (!seen.has(key)) return initialWindow;
    const opened = await store();
    return await opened.runPromise(readWindow(check(key, { name: "conformance", limit: 1, windowMs: 1 })));
  },
  async [Symbol.asyncDispose]() {
    await runtime?.dispose();
    runtime = undefined;
  },
};

export const options: Options = { keys: ["203.0.113.7", "198.51.100.9"], walks: 20, steps: 25 };
