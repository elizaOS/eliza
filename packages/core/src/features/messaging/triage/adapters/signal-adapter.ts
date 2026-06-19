import type { IAgentRuntime } from "../../../../types/index.ts";
import type { MessageAdapterCapabilities, MessageSource } from "../types.ts";
import { BaseMessageAdapter } from "./base.ts";

export class SignalMessageAdapter extends BaseMessageAdapter {
	readonly source: MessageSource = "signal";

	isAvailable(runtime: IAgentRuntime): boolean {
		return runtime.getService("signal") != null;
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
