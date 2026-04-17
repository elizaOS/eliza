import type { IAgentRuntime } from "../../../../types/index.ts";
import type { MessageSource } from "../types.ts";
import { BaseMessageAdapter } from "./base.ts";

/**
 * Gmail adapter. Availability hinges on the gmail service (provided by
 * `@elizaos/plugin-gmail` / lifeops Gmail integration) being registered.
 */
export class GmailMessageAdapter extends BaseMessageAdapter {
	readonly source: MessageSource = "gmail";

	isAvailable(runtime: IAgentRuntime): boolean {
		return runtime.getService("gmail") !== null &&
			runtime.getService("gmail") !== undefined;
	}
}
