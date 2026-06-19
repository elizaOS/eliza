import type { IAgentRuntime } from "../../../../types/index.ts";
import type { MessageAdapterCapabilities, MessageSource } from "../types.ts";
import { BaseMessageAdapter } from "./base.ts";

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
