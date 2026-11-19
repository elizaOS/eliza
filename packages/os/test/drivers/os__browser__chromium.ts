// spec/os/browser/chromium.md, "Story: Use the owned browser only with its expected identity"
import readline from "node:readline";
import type { Driver, Options } from "../../gen/os__browser__chromium.conformance.ts";
import type { BrowserBinding, Event } from "../../gen/os__browser__chromium.ts";
import { jvmDriver } from "./jvm-adapter.ts";

const KEY = "binding";

export type HeldByJava = Omit<BrowserBinding, "nextHold">;

const ascending = (ids: readonly number[]) => [...ids].sort((a, b) => a - b);

const view = ({ nextHold: _named, openHolds, fired, ...held }: BrowserBinding): HeldByJava =>
  ({ ...held, openHolds: ascending(openHolds), fired: ascending(fired) });

const replay = jvmDriver<Event, BrowserBinding>("ai.eliza.plugins.browsersurface.ChromiumBindingReplay");

export const driver: Driver<HeldByJava> & AsyncDisposable = { ...replay, observe: async (key) => view(await replay.observe(key)) };
export const options: Options<HeldByJava> = { keys: [KEY], view };

if (import.meta.main) {
  for await (const line of readline.createInterface({ input: process.stdin })) {
    if (line.trim() === "") continue;
    const event = (JSON.parse(line) as { event?: Event }).event;
    if (event === undefined) await replay.reset();
    else await replay.dispatch(KEY, event);
    const out = event === undefined ? undefined : await replay.observeOutput?.(KEY);
    process.stdout.write(`${JSON.stringify({ state: await replay.observe(KEY), out })}\n`);
  }
  await replay[Symbol.asyncDispose]();
}
