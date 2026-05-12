import type { IAgentRuntime } from "../../../../types/index.ts";
import type { MessageAdapterCapabilities, MessageSource } from "../types.ts";
import { BaseMessageAdapter } from "./base.ts";

/**
 * Gmail adapter. Availability hinges on the gmail service (provided by
 * `@elizaos/plugin-gmail` / lifeops Gmail integration) being registered.
 */
export class GmailMessageAdapter extends BaseMessageAdapter {
	readonly source: MessageSource = "gmail";

	isAvailable(runtime: IAgentRuntime): boolean {
		return (
			runtime.getService("gmail") !== null &&
			runtime.getService("gmail") !== undefined
		);
	}

	capabilities(): MessageAdapterCapabilities {
		// Gmail accounts are world-scoped, labels are explicit channels.
		// All operational flags default off until the T5X adapter wires them up.
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
