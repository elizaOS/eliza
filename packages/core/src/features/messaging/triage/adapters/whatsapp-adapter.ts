import type { IAgentRuntime } from "../../../../types/index.ts";
import type { MessageSource } from "../types.ts";
import { BaseMessageAdapter } from "./base.ts";

export class WhatsappMessageAdapter extends BaseMessageAdapter {
	readonly source: MessageSource = "whatsapp";

	isAvailable(runtime: IAgentRuntime): boolean {
		return runtime.getService("whatsapp") != null;
	}
}
