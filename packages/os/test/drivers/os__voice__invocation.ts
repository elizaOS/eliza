// spec/os/voice/invocation.md, "Story: Start voice from a trusted gesture, once"
import type { Driver, Options } from "../../gen/os__voice__invocation.conformance.ts";
import type { Answer, Invocation, Origin, Pending } from "../../gen/os__voice__invocation.ts";
import { jvmDriver } from "./jvm-adapter.ts";

type WithoutArrival<T> = T extends unknown ? Omit<T, "arrival"> : never;
type Observed = Pick<Invocation, "binding" | "owner" | "listenerAdmission"> & {
  readonly pending: WithoutArrival<Pending>;
  readonly answer: { readonly tag: "NoAnswer" | "OpenOnly" } | { readonly tag: "VoiceStart"; readonly origin: Origin };
};

const pending = (p: Pending): WithoutArrival<Pending> => {
  if (p.tag === "NoArrival") return p;
  const { arrival: _arrival, ...seen } = p;
  return seen;
};

const answer = (a: Answer): Observed["answer"] => a.tag === "VoiceStart" ? { tag: a.tag, origin: a.origin } : { tag: a.tag };

export const driver: Driver<Observed> = jvmDriver("ai.eliza.plugins.system.InvocationReplay");

export const options: Options<Observed> = {
  keys: ["invocation"],
  view: (s) => ({ binding: s.binding, owner: s.owner, listenerAdmission: s.listenerAdmission, pending: pending(s.pending), answer: answer(s.answer) }),
};
