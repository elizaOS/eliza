import {
	BaseMessageAdapter,
	getDefaultTriageService,
	type IAgentRuntime,
	type MessageAdapterCapabilities,
	type MessageSource,
} from "@elizaos/core";

/**
 * WhatsApp triage adapter. Availability hinges on the whatsapp service (provided
 * by this plugin) being registered. Registered into the shared TriageService so
 * cross-connector MESSAGE triage recognizes the "whatsapp" source. Capability
 * flags default off until the underlying adapter wires them up.
 */
export class WhatsappMessageAdapter extends BaseMessageAdapter {
	readonly source: MessageSource = "whatsapp";

	isAvailable(runtime: IAgentRuntime): boolean {
		return runtime.getService("whatsapp") != null;
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

export function registerWhatsappTriageAdapter(): void {
	getDefaultTriageService().register(new WhatsappMessageAdapter());
}
