// How `pnpm check` reaches a browser tab to compare it with spec/client.md (SPEC.md, "Conformance"): every journey
// and random walks through the tab's own `dispatch`, over the generated client Machine that `browser` gives it, each
// trace with a fresh tab. Nothing here reaches the server.
import { ManagedRuntime } from "effect";
import type { Driver, Options } from "../../gen/client.conformance.ts";
import { Tab, browser } from "../../src/web/sync.vibe";

const fresh = () => ManagedRuntime.make(browser("http://localhost", "ann"));
let tab = fresh();

export const driver: Driver & AsyncDisposable = {
  reset: async () => {
    await tab.dispose();
    tab = fresh();
  },
  // `dispatch` says false where the Machine failed with Rejected, and the state is unchanged.
  dispatch: async (_key, event) => ((await tab.runPromise(Tab.use((t) => t.dispatch(event)))) ? "accepted" : "refused"),
  observe: () => tab.runPromise(Tab.use((t) => t.get())),
  [Symbol.asyncDispose]: () => tab.dispose(),
};

/** One tab, so one key. */
export const options: Options = { keys: ["tab"] };
