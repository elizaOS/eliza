// spec/os/android/notificationMirror.md, "Story: Mirror only the notifications I allowed"
import readline from "node:readline";
import type { Driver, Options } from "../../gen/os__android__notificationMirror.conformance.ts";
import { jvmDriver } from "./jvm-adapter.ts";

const KEY = "mirror";

export const driver: Driver & AsyncDisposable = jvmDriver("ai.eliza.plugins.notifications.NotificationMirrorAdapter");

export const options: Options = { keys: [KEY] };

if (import.meta.main) {
  const answer = async (line: string) => {
    const request: unknown = JSON.parse(line);
    if (typeof request !== "object" || request === null || Array.isArray(request)) throw new Error(`not a driver request: ${line}`);
    const event = (request as { event?: Parameters<Driver["dispatch"]>[1] }).event;
    if (event === undefined) await driver.reset();
    else await driver.dispatch(KEY, event);
    return { state: await driver.observe(KEY), out: await driver.observeOutput?.(KEY) };
  };
  for await (const line of readline.createInterface({ input: process.stdin })) {
    if (line.trim() === "") continue;
    process.stdout.write(`${JSON.stringify(await answer(line))}\n`);
  }
  await driver[Symbol.asyncDispose]();
}
