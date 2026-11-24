// spec/os/appUpdate/install.md, "Story: Install an app update without running the agent mid-install"; spec/os/appUpdate/install.md, "Story: Recover from an unhealthy update once"
import type { Driver, Options } from "../../gen/os__appUpdate__install.conformance.ts";
import { answerDriverLines, jvmDriver } from "./jvm-adapter.ts";

const KEY = "device";

export const driver: Driver & AsyncDisposable = jvmDriver("ai.eliza.plugins.agent.updater.InstallJournalAdapter");

export const options: Options = { keys: [KEY] };

if (import.meta.main) await answerDriverLines(driver, KEY, (key) => driver.observeOutput?.(key), true);
