// spec/os/update/updater.md, "Story: Install a verified update once"
import readline from "node:readline";
import type { Driver, Options } from "../../gen/os__update__updater.conformance.ts";
import { jvmDriver } from "./jvm-adapter.ts";

const KEY = "device";

export const driver: Driver & AsyncDisposable = jvmDriver("ai.eliza.systemupdater.SystemUpdateAdapter", { receives: true });

export const options: Options = { keys: [KEY] };

if (import.meta.main) {
  const answer = async (line: string) => {
    const request: unknown = JSON.parse(line);
    if (typeof request !== "object" || request === null || Array.isArray(request)) throw new Error(`not a driver request: ${line}`);
    const event = (request as { event?: Parameters<Driver["dispatch"]>[1] }).event;
    if (event === undefined) {
      await driver.reset();
      return { state: await driver.observe(KEY) };
    }
    const outcome = await driver.dispatch(KEY, event);
    return { outcome, state: await driver.observe(KEY) };
  };
  for await (const line of readline.createInterface({ input: process.stdin })) {
    if (line.trim() === "") continue;
    process.stdout.write(`${JSON.stringify(await answer(line))}\n`);
  }
  await driver[Symbol.asyncDispose]();
}
