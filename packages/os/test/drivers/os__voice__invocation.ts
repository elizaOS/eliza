// spec/os/voice/invocation.md, "Story: Start voice from a trusted gesture, once"
import type { Driver, Options } from "../../gen/os__voice__invocation.conformance.ts";
import { jvmDriver } from "./jvm-adapter.ts";

export const driver: Driver = jvmDriver("ai.eliza.plugins.system.InvocationReplay");

export const options: Options = { keys: ["invocation"] };
