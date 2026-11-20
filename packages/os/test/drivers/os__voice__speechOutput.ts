// spec/os/voice/speechOutput.md, "Story: Prime the audio output without playing over anything"; spec/os/voice/speechOutput.md, "Story: Start a reply's audio promptly without playing over anything"
import type { Driver, Options } from "../../gen/os__voice__speechOutput.conformance.ts";
import { jvmDriver } from "./jvm-adapter.ts";

export const driver: Driver = jvmDriver("ai.eliza.voice.SpeechOutputReplay");

export const options: Options = { keys: ["output"] };
