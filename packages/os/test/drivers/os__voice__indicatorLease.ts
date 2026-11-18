// spec/os/voice/indicatorLease.md, "Story: Never listen without a visible indicator"; spec/os/voice/indicatorLease.md, "Story: Acknowledge only what SystemUI itself measures"
import type { Driver, Options } from "../../gen/os__voice__indicatorLease.conformance.ts";
import type { EndCause, IndicatorLease } from "../../gen/os__voice__indicatorLease.ts";
import { jvmDriver } from "./jvm-adapter.ts";

type Observed = Omit<IndicatorLease, "ended"> & { readonly ended: EndCause | null };

export const driver: Driver<Observed> = jvmDriver("com.android.systemui.privacy.IndicatorLeaseReplay");

export const options: Options<Observed> = {
  keys: ["lease"],
  view: (state) => ({ ...state, ended: state.phase === "Unleased" ? state.ended : null }),
};
