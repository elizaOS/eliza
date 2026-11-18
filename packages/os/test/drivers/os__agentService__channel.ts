// spec/os/agentService/channel.md, "Story: Ask the agent only on the routes my app allows"; spec/os/agentService/channel.md, "Story: Stream a reply and stop it"; spec/os/agentService/channel.md, "Story: Receive the agent's live events for my screen"
import readline from "node:readline";
import type { Driver, Options } from "../../gen/os__agentService__channel.conformance.ts";
import { jvmDriver } from "./jvm-adapter.ts";

const KEY = "device";

export const driver: Driver & AsyncDisposable = jvmDriver("ai.eliza.os.agent.ChannelAdapter", { receives: true });
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
