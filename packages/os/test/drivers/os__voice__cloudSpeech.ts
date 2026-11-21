// spec/os/voice/cloudSpeech.md, "Story: Talk to the agent through the cloud speech relay"; spec/os/voice/cloudSpeech.md, "Story: Transcribe a recording or hear a reply with one cloud request"
import type { Driver, Options } from "../../gen/os__voice__cloudSpeech.conformance.ts";
import { jvmDriver } from "./jvm-adapter.ts";

export const driver: Driver = jvmDriver("ai.eliza.voice.CloudSpeechReplay");

export const options: Options = { keys: ["speech"] };
