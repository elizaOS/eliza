// spec/os/android/files/storageWatch.md, "Story: Watch a folder with one live observer"
import type { Driver, Options } from "../../gen/os__android__files__storageWatch.conformance.ts";
import { jvmDriver } from "./jvm-adapter.ts";

export const driver: Driver = jvmDriver("ai.eliza.files.StorageWatchReplay");

export const options: Options = { keys: ["files"] };
