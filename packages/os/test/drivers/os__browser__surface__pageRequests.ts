// spec/os/browser/surface/pageRequests.md, "Story: Answer what a page asks, once, only while it is mine"; spec/os/browser/surface/pageRequests.md, "Story: Let a site have the device, my files or a download only as I choose"; spec/os/browser/surface/pageRequests.md, "Story: Leave the page for another app or a full browser only when I choose"
import readline from "node:readline";
import type { Driver, Options } from "../../gen/os__browser__surface__pageRequests.conformance.ts";
import { jvmDriver } from "./jvm-adapter.ts";

const KEY = "surfaces";

export const driver: Driver & AsyncDisposable = jvmDriver("ai.eliza.plugins.browsersurface.PageRequestsReplay");
export const options: Options = { keys: [KEY] };

if (import.meta.main) {
  const answer = async (line: string) => {
    const request: unknown = JSON.parse(line);
    if (typeof request !== "object" || request === null || Array.isArray(request)) throw new Error(`not a driver request: ${line}`);
    const event = (request as { event?: Parameters<typeof driver.dispatch>[1] }).event;
    if (event === undefined) await driver.reset();
    else await driver.dispatch(KEY, event);
    return { state: await driver.observe(KEY), out: event === undefined ? [] : await driver.observeOutput?.(KEY) };
  };
  for await (const line of readline.createInterface({ input: process.stdin })) {
    if (line.trim() === "") continue;
    process.stdout.write(`${JSON.stringify(await answer(line))}\n`);
  }
  await driver[Symbol.asyncDispose]();
}
