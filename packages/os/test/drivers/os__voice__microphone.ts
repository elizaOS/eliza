// spec/os/voice/microphone.md, "Story: Share the microphone between live capture and dictation"; spec/os/voice/microphone.md, "Story: Dictate a draft while live capture was running"
import type { Driver, Options } from "../../gen/os__voice__microphone.conformance.ts";
import { jvmDriver } from "./jvm-adapter.ts";

export const driver: Driver = jvmDriver("ai.eliza.voice.MicrophoneReplay");

export const options: Options = { keys: ["slot"] };
