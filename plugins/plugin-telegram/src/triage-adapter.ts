import {
	BaseMessageAdapter,
	getDefaultTriageService,
	type IAgentRuntime,
	type MessageAdapterCapabilities,
	type MessageSource,
} from "@elizaos/core";

/**
 * Telegram triage adapter. Availability hinges on the telegram service (provided
 * by this plugin) being registered. Registered into the shared TriageService so
 * cross-connector MESSAGE triage recognizes the "telegram" source. Capability
 * flags default off until the underlying adapter wires them up.
 */
export class TelegramMessageAdapter extends BaseMessageAdapter {
	readonly source: MessageSource = "telegram";

	isAvailable(runtime: IAgentRuntime): boolean {
		return runtime.getService("telegram") != null;
	}

	capabilities(): MessageAdapterCapabilities {
		return {
			list: false,
			search: false,
			manage: {},
			send: {},
			worlds: "single",
			channels: "explicit",
		};
	}
}

export function registerTelegramTriageAdapter(): void {
	getDefaultTriageService().register(new TelegramMessageAdapter());
}
