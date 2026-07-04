/**
 * Registers the Discord message adapter with the shared TriageService so
 * cross-connector MESSAGE triage recognizes the `discord` source. Availability
 * hinges on the `DiscordService` being registered.
 */
import {
	BaseMessageAdapter,
	getDefaultTriageService,
	type IAgentRuntime,
	type MessageAdapterCapabilities,
	type MessageSource,
} from "@elizaos/core";

/**
 * Discord triage adapter. Availability hinges on the discord service (provided
 * by this plugin) being registered. Registered into the shared TriageService so
 * cross-connector MESSAGE triage recognizes the "discord" source.
 *
 * Discord servers + channels + threads; native search; reactions/pins model
 * labels + mute. Until the underlying adapter ships nothing is wired, so all
 * capability flags default off — flip per-flag as functionality arrives.
 */
export class DiscordMessageAdapter extends BaseMessageAdapter {
	readonly source: MessageSource = "discord";

	isAvailable(runtime: IAgentRuntime): boolean {
		return runtime.getService("discord") != null;
	}

	capabilities(): MessageAdapterCapabilities {
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

export function registerDiscordTriageAdapter(): void {
	getDefaultTriageService().register(new DiscordMessageAdapter());
}
