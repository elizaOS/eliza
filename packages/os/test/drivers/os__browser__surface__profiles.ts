// spec/os/browser/surface/profiles.md, "Story: Keep two sites' storage apart unless I share a profile"; spec/os/browser/surface/profiles.md, "Story: Sign the device out of websites"
import readline from "node:readline";
import type { Driver, Options } from "../../gen/os__browser__surface__profiles.conformance.ts";
import type { Event, ProfilePurge } from "../../gen/os__browser__surface__profiles.ts";
import { jvmDriver } from "./jvm-adapter.ts";

const KEY = "profiles";

export type HeldByJava = Pick<ProfilePurge, "profiles" | "surfaces" | "clearing" | "answer">;

const view = ({ profiles, surfaces, clearing, answer }: ProfilePurge): HeldByJava => ({ profiles, surfaces, clearing, answer });

const replay = jvmDriver<Event, ProfilePurge>("ai.eliza.plugins.browsersurface.ProfilePurgeReplay");

export const driver: Driver<HeldByJava> & AsyncDisposable = { ...replay, observe: async (key) => view(await replay.observe(key)) };
export const options: Options<HeldByJava> = { keys: [KEY], view };

if (import.meta.main) {
  for await (const line of readline.createInterface({ input: process.stdin })) {
    if (line.trim() === "") continue;
    const event = (JSON.parse(line) as { event?: Event }).event;
    if (event === undefined) await replay.reset();
    else await replay.dispatch(KEY, event);
    process.stdout.write(`${JSON.stringify({ state: await replay.observe(KEY) })}\n`);
  }
  await replay[Symbol.asyncDispose]();
}
