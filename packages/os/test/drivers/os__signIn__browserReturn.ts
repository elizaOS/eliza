// spec/os/signIn/browserReturn.md, "Story: Complete a browser sign-in only for the client that started it"; spec/os/signIn/browserReturn.md, "Story: Come back to the app after a failed browser sign-in"
import type { Driver, Options } from "../../gen/os__signIn__browserReturn.conformance.ts";
import type { BrowserReturns } from "../../gen/os__signIn__browserReturn.ts";
import { jvmDriver } from "./jvm-adapter.ts";

const view = (s: BrowserReturns) => ({
  credential: { generation: s.credential.generation, attempt: s.credential.attempt },
  record: s.record,
  attempt: s.attempt,
  retirement: s.retirement,
  links: { captured: s.links.captured, pending: s.links.pending },
});

type Observed = ReturnType<typeof view>;

export const driver: Driver<Observed> = jvmDriver("ai.eliza.plugins.signin.BrowserReturnReplay");

export const options: Options<Observed> = { keys: ["device"], view };
