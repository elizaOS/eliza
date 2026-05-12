import type { IAgentRuntime } from "../../../../types/index.ts";
import type { MessageAdapterCapabilities, MessageSource } from "../types.ts";
import { BaseMessageAdapter } from "./base.ts";

export class DiscordMessageAdapter extends BaseMessageAdapter {
	readonly source: MessageSource = "discord";

	isAvailable(runtime: IAgentRuntime): boolean {
		return runtime.getService("discord") != null;
	}

	capabilities(): MessageAdapterCapabilities {
		// Discord servers + channels + threads; native search; reactions/pins
		// model labels + mute. Until the underlying T5X adapter ships nothing
		// is wired, so all flags default off — flip per-flag as functionality
		// arrives.
		return {
			list: false,
			search: false,
			manage: {},
			send: {},
			worlds: "multi",
			channels: "explicit",
		};
	}
}
