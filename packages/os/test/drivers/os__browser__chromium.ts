// spec/os/browser/chromium.md, "Story: Use the owned browser only with its expected identity"
import readline from "node:readline";
import type { Driver, Options } from "../../gen/os__browser__chromium.conformance.ts";
import { jvmDriver } from "./jvm-adapter.ts";

const KEY = "binding";

export const driver: Driver & AsyncDisposable = jvmDriver("ai.eliza.plugins.browsersurface.ChromiumBindingReplay");
export const options: Options = { keys: [KEY] };

if (import.meta.main) {
  for await (const line of readline.createInterface({ input: process.stdin })) {
    if (line.trim() === "") continue;
    const event = (JSON.parse(line) as { event?: Parameters<typeof driver.dispatch>[1] }).event;
    if (event === undefined) await driver.reset();
    else await driver.dispatch(KEY, event);
    const out = event === undefined ? undefined : await driver.observeOutput?.(KEY);
    process.stdout.write(`${JSON.stringify({ state: await driver.observe(KEY), out })}\n`);
  }
  await driver[Symbol.asyncDispose]();
}
