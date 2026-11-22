// spec/os/build/androidBuild.md, "Story: Replace published APKs only with this run's verified set"
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import readline from "node:readline";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Exit } from "effect";
import type { Driver, Options } from "../../gen/os__build__androidBuild.conformance.ts";
import type { AndroidBuild, Event } from "../../gen/os__build__androidBuild.ts";
import { openAndroidBuild, type AndroidBuildRun } from "../../src/build/android-build.vibe";

const roots = new Map<string, string>();

function rootOf(key: string): string {
  const found = roots.get(key);
  if (found !== undefined) return found;
  const made = mkdtempSync(path.join(tmpdir(), "eliza-os-android-build-"));
  roots.set(key, made);
  return made;
}

const opened = (key: string) =>
  openAndroidBuild({ root: rootOf(key), variants: [], pin: "", verify: { command: "true", args: [] } }).pipe(Effect.provide(NodeServices.layer));

async function settle(key: string, step: (run: AndroidBuildRun) => Effect.Effect<AndroidBuild, { readonly _tag: string }>): Promise<"accepted" | "refused"> {
  const exit = await Effect.runPromiseExit(Effect.flatMap(opened(key), step));
  if (Exit.isSuccess(exit)) return "accepted";
  const tags = exit.cause.reasons.flatMap((reason) => reason._tag === "Fail" ? [reason.error._tag] : []);
  if (tags.includes("Rejected") || tags.includes("NotAnEvent")) return "refused";
  throw new Error(`the Android build store failed: ${String(exit.cause)}`);
}

function reset(): void {
  for (const root of roots.values()) rmSync(root, { recursive: true, force: true });
  roots.clear();
}

export const driver: Driver & AsyncDisposable = {
  reset,
  dispatch: (key, event: Event) => settle(key, (run) => run.machine.send(event)),
  receive: (key, raw) => settle(key, (run) => run.machine.receive(raw)),
  observe: (key) => Effect.runPromise(Effect.flatMap(opened(key), (run) => run.machine.get())),
  [Symbol.asyncDispose]: () => new Promise<void>((resolve) => {
    reset();
    resolve();
  }),
};

export const options: Options = { keys: ["consumer", "other"] };

if (import.meta.main) {
  for await (const line of readline.createInterface({ input: process.stdin })) {
    if (line.trim() === "") continue;
    const event = (JSON.parse(line) as { event?: Event }).event;
    if (event === undefined) await driver.reset();
    else await driver.dispatch("consumer", event);
    process.stdout.write(`${JSON.stringify({ state: await driver.observe("consumer") })}\n`);
  }
  await driver[Symbol.asyncDispose]();
}
