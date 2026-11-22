// spec/cloud/billing/providerEvents.md, "Story: Apply each payment event once, whatever the delivery order"; spec/cloud/billing/providerEvents.md, "Story: Keep an event that cannot be applied until the provider sends it again"
import { Effect } from "effect";
import type { Driver, Options } from "../../gen/cloud__billing__providerEvents.conformance.ts";
import type { Event, ProviderEvent } from "../../gen/cloud__billing__providerEvents.ts";
import { advanceProviderEvent, appendProviderEvent, emptyProviderEvent, lockedEvent, providerEventAt, providerEventName, queuedState } from "../../src/billing/provider-events.vibe";
import { ledger, within, type Settled } from "../support/ledger.ts";

const cloud = ledger();
let storedId: string | undefined;
let beforeDelivery = 0;

function must<A>(action: string, done: Settled<A>): A {
  if (done.kind === "failed") throw new Error(`${action} failed with ${done.tag}`, { cause: done.error });
  return done.value;
}

async function observe(): Promise<ProviderEvent> {
  const id = storedId;
  if (id === undefined) return providerEventAt(emptyProviderEvent, beforeDelivery);
  const row = must("read the event", await cloud.run(within((tx) => lockedEvent(tx, id))));
  const event = row === undefined ? undefined : queuedState(row);
  if (event === undefined) throw new Error("the stored provider event could not be read");
  return event;
}

async function dispatch(_key: string, event: Event): Promise<"accepted" | "refused"> {
  if (event.type === "receive" && storedId === undefined) {
    const type = providerEventName(event.eventType);
    const payload = JSON.stringify({ id: event.eventId, type, created: 0, livemode: event.livemode, data: { object: {} } });
    const appended = await cloud.run(within((tx) => appendProviderEvent(tx, event, { type, payload, now: beforeDelivery })));
    if (appended.kind === "failed" && appended.tag === "Rejected") return "refused";
    if (!must("store the verified delivery", appended)) return "refused";
    storedId = event.eventId;
    return "accepted";
  }
  const id = storedId;
  const code = event.type === "finish" && event.result.tag === "Failed"
    ? event.result.error === "PayloadParseFailed" ? "ProviderEventMalformed" : event.result.error
    : null;
  const advanced = await cloud.run(within((tx) => Effect.gen(function* () {
    const row = id === undefined ? undefined : yield* lockedEvent(tx, id);
    const state = row === undefined ? providerEventAt(emptyProviderEvent, beforeDelivery) : queuedState(row);
    if (state === undefined) throw new Error("the stored queue state is unreadable");
    return yield* advanceProviderEvent(tx, state, event, event.type === "elapse" && typeof row?.last_error_code === "string" ? row.last_error_code : code);
  })));
  if (advanced.kind === "failed" && advanced.tag === "Rejected") return "refused";
  const current = must("step the provider event", advanced);
  if (id === undefined) beforeDelivery = current.lease.now;
  return "accepted";
}

export const driver: Driver & AsyncDisposable = {
  async reset() {
    storedId = undefined;
    beforeDelivery = 0;
    await cloud.reset([]);
    await cloud.sql("TRUNCATE provider_events");
  },
  dispatch,
  observe,
  [Symbol.asyncDispose]: () => cloud.dispose(),
};

export const options: Options = {
  keys: ["provider-event"],
  view: (state) => ({ ...state, dueAt: Math.max(state.dueAt, state.lease.leaseUntil) }),
};
