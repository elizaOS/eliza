// How `pnpm check` reaches the order book to compare it with spec/index.md (SPEC.md, "Conformance"): every
// journey, malformed inputs and random walks over two orders at once, each trace with a fresh book.
import { Effect, ManagedRuntime } from "effect";
import type { Driver } from "../../gen/index.conformance.ts";
import type { Role } from "../../gen/index.ts";
import { OrderBook, OrderBookMemory } from "../../src/app.vibe";

let book = ManagedRuntime.make(OrderBookMemory);
const refused = () => Effect.succeed("refused" as const);

/** What the book did with `input` from `by`, as the network would send it: any failure but a refusal stays a failure. */
const receive = (id: string, input: unknown, by: unknown) =>
  book.runPromise(OrderBook.use((b) => b.dispatch(id, input, by as Role)).pipe(Effect.as("accepted" as const), Effect.catchTags({ Rejected: refused, NotAnEvent: refused })));

export const driver: Driver & AsyncDisposable = {
  reset: async () => {
    await book.dispose();
    book = ManagedRuntime.make(OrderBookMemory);
  },
  dispatch: receive,
  receive,
  observe: (id) => book.runPromise(OrderBook.use((b) => b.get(id))),
  [Symbol.asyncDispose]: () => book.dispose(),
};
