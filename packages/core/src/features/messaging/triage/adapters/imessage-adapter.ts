import type { IAgentRuntime } from "../../../../types/index.ts";
import type { MessageAdapterCapabilities, MessageSource } from "../types.ts";
import { BaseMessageAdapter } from "./base.ts";

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
