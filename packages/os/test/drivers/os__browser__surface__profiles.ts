// spec/os/browser/surface/profiles.md, "Story: Keep two sites' storage apart unless I share a profile"; spec/os/browser/surface/profiles.md, "Story: Sign the device out of websites"
import readline from "node:readline";
import type { Driver, Options } from "../../gen/os__browser__surface__profiles.conformance.ts";
import { jvmDriver } from "./jvm-adapter.ts";

const KEY = "profiles";

export const driver: Driver & AsyncDisposable = jvmDriver("ai.eliza.plugins.browsersurface.ProfilePurgeReplay");
export const options: Options = { keys: [KEY] };

if (import.meta.main) {
  for await (const line of readline.createInterface({ input: process.stdin })) {
    if (line.trim() === "") continue;
    const event = (JSON.parse(line) as { event?: Parameters<typeof driver.dispatch>[1] }).event;
    if (event === undefined) await driver.reset();
    else await driver.dispatch(KEY, event);
    process.stdout.write(`${JSON.stringify({ state: await driver.observe(KEY) })}\n`);
  }
  await driver[Symbol.asyncDispose]();
}
