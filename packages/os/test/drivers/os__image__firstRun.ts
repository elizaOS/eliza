// spec/os/image/firstRun.md, "Story: Have my device's default apps set on first boot without overriding my choices"
import type { Driver, Options } from "../../gen/os__image__firstRun.conformance.ts";
import { answerDriverLines, jvmDriver } from "./jvm-adapter.ts";

const KEY = "device";

export const driver: Driver & AsyncDisposable = jvmDriver("ai.eliza.firstrun.FirstRunReplay");

export const options: Options = { keys: [KEY] };

if (import.meta.main) await answerDriverLines(driver, KEY);
