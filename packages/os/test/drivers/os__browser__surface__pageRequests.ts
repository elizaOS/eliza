// spec/os/browser/surface/pageRequests.md, "Story: Answer what a page asks, once, only while it is mine"; spec/os/browser/surface/pageRequests.md, "Story: Let a site have the device, my files or a download only as I choose"; spec/os/browser/surface/pageRequests.md, "Story: Leave the page for another app or a full browser only when I choose"
import type { Driver, Options } from "../../gen/os__browser__surface__pageRequests.conformance.ts";
import { answerDriverLines, jvmDriver } from "./jvm-adapter.ts";

const KEY = "surfaces";

export const driver: Driver & AsyncDisposable = jvmDriver("ai.eliza.plugins.browsersurface.PageRequestsReplay");
export const options: Options = { keys: [KEY] };

if (import.meta.main) await answerDriverLines(driver, KEY, (key) => driver.observeOutput?.(key));
