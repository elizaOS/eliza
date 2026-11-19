// spec/os/android/secureStore.md, "Story: Persist a value without losing a newer edit"
import type { Driver, Options } from "../../gen/os__android__secureStore.conformance.ts";
import { jvmDriver } from "./jvm-adapter.ts";

export const driver: Driver = jvmDriver("ai.eliza.plugins.securestore.nativeonly.SlotExchangeReplay");

export const options: Options = { keys: ["slots"] };
