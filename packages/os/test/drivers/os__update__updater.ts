// spec/os/update/updater.md, "Story: Install a verified update once"
import type { Driver, Options } from "../../gen/os__update__updater.conformance.ts";
import type { SystemUpdate } from "../../gen/os__update__updater.ts";
import { jvmDriver } from "./jvm-adapter.ts";

type Journal = Omit<SystemUpdate, "restartHold">;

export const driver: Driver<Journal> & AsyncDisposable = jvmDriver("ai.eliza.systemupdater.JournalReplay");

export const options: Options<Journal> = {
  keys: ["device"],
  view: ({ phase, source, target, digest, intentBoot, applyCalls }) => ({ phase, source, target, digest, intentBoot, applyCalls }),
};
