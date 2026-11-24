// spec/os/agentService/channel.md, "Story: Ask the agent only on the routes my app allows"; spec/os/agentService/channel.md, "Story: Stream a reply and stop it"; spec/os/agentService/channel.md, "Story: Receive the agent's live events for my screen"
import type { Driver, Options } from "../../gen/os__agentService__channel.conformance.ts";
import { answerDriverLines, jvmDriver } from "./jvm-adapter.ts";

const KEY = "device";

export const driver: Driver & AsyncDisposable = jvmDriver("ai.eliza.os.agent.ChannelAdapter", { receives: true });
export const options: Options = { keys: [KEY] };

if (import.meta.main) await answerDriverLines(driver, KEY, (key) => driver.observeOutput?.(key));
