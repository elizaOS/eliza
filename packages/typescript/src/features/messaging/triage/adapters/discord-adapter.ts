import type { IAgentRuntime } from "../../../../types/index.ts";
import type { MessageSource } from "../types.ts";
import { BaseMessageAdapter } from "./base.ts";

export class DiscordMessageAdapter extends BaseMessageAdapter {
	readonly source: MessageSource = "discord";

	isAvailable(runtime: IAgentRuntime): boolean {
		return runtime.getService("discord") != null;
	}
}
