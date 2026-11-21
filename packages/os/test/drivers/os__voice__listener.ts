// spec/os/voice/listener.md, "Story: Keep wake listening on the device under my control"; spec/os/voice/listener.md, "Story: Listen only while the indicator shows it"
import type { Driver, Options } from "../../gen/os__voice__listener.conformance.ts";
import type { ListenerService } from "../../gen/os__voice__listener.ts";
import type { EndCause, IndicatorLease } from "../../gen/os__voice__indicatorLease.ts";
import { jvmDriver } from "./jvm-adapter.ts";

type Observed = Omit<ListenerService, "lease"> & { readonly lease: Omit<IndicatorLease, "ended"> & { readonly ended: EndCause | null } };

export const driver: Driver<Observed> = jvmDriver("ai.eliza.sense.ListenerReplay");

export const options: Options<Observed> = {
  keys: ["listener"],
  view: (state) => ({ ...state, lease: { ...state.lease, ended: state.lease.phase === "Unleased" ? state.lease.ended : null } }),
};
