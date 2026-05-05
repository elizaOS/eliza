import type { IAgentRuntime } from "../../../../types/index.ts";
import type { MessageAdapterCapabilities, MessageSource } from "../types.ts";
import { BaseMessageAdapter } from "./base.ts";

export class TwitterMessageAdapter extends BaseMessageAdapter {
	readonly source: MessageSource = "twitter";

	isAvailable(runtime: IAgentRuntime): boolean {
		return (
			runtime.getService("twitter") != null || runtime.getService("x") != null
		);
	}

	capabilities(): MessageAdapterCapabilities {
		return {
			list: false,
			search: false,
			manage: {},
			send: {},
			worlds: "multi",
			channels: "implicit",
		};
	}
}
