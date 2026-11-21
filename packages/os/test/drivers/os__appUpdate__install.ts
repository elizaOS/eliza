// spec/os/appUpdate/install.md, "Story: Install an app update without running the agent mid-install"; spec/os/appUpdate/install.md, "Story: Recover from an unhealthy update once"
import readline from "node:readline";
import type { Driver, Options } from "../../gen/os__appUpdate__install.conformance.ts";
import { jvmDriver } from "./jvm-adapter.ts";

const KEY = "device";

export const driver: Driver & AsyncDisposable = jvmDriver("ai.eliza.plugins.agent.updater.InstallJournalAdapter");

export const options: Options = { keys: [KEY] };

if (import.meta.main) {
  const answer = async (line: string) => {
    const request: unknown = JSON.parse(line);
    if (typeof request !== "object" || request === null || Array.isArray(request)) throw new Error(`not a driver request: ${line}`);
    const event = (request as { event?: Parameters<Driver["dispatch"]>[1] }).event;
    if (event === undefined) {
      await driver.reset();
      return { state: await driver.observe(KEY), out: [] };
    }
    const outcome = await driver.dispatch(KEY, event);
    return { outcome, state: await driver.observe(KEY), out: await driver.observeOutput?.(KEY) };
  };
  for await (const line of readline.createInterface({ input: process.stdin })) {
    if (line.trim() === "") continue;
    process.stdout.write(`${JSON.stringify(await answer(line))}\n`);
  }
  await driver[Symbol.asyncDispose]();
}
