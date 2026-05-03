import type { IAgentRuntime } from "../../../../types/index.ts";
import type { MessageSource } from "../types.ts";
import { BaseMessageAdapter } from "./base.ts";

export class IMessageMessageAdapter extends BaseMessageAdapter {
	readonly source: MessageSource = "imessage";

	isAvailable(runtime: IAgentRuntime): boolean {
		return (
			runtime.getService("imessage") != null ||
			runtime.getService("bluebubbles") != null
		);
	}
}
