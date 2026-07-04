import {
	BaseMessageAdapter,
	getDefaultTriageService,
	type IAgentRuntime,
	type MessageAdapterCapabilities,
	type MessageSource,
} from "@elizaos/core";

/**
 * iMessage triage adapter. Availability hinges on the imessage service (or the
 * bluebubbles bridge) being registered by this plugin. Registered into the
 * shared TriageService so cross-connector MESSAGE triage recognizes the
 * "imessage" source. Capability flags default off until the underlying adapter
 * wires them up.
 */
export class IMessageMessageAdapter extends BaseMessageAdapter {
	readonly source: MessageSource = "imessage";

	isAvailable(runtime: IAgentRuntime): boolean {
		return (
			runtime.getService("imessage") != null ||
			runtime.getService("bluebubbles") != null
		);
	}

	capabilities(): MessageAdapterCapabilities {
		return {
			list: false,
			search: false,
			manage: {},
			send: {},
			worlds: "single",
			channels: "implicit",
		};
	}
}

export function registerIMessageTriageAdapter(): void {
	getDefaultTriageService().register(new IMessageMessageAdapter());
}
