import type { IAgentRuntime } from "../../../../types/index.ts";
import type { MessageAdapterCapabilities, MessageSource } from "../types.ts";
import { BaseMessageAdapter } from "./base.ts";

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
