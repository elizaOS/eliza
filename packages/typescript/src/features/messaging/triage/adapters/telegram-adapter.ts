import type { IAgentRuntime } from "../../../../types/index.ts";
import type { MessageSource } from "../types.ts";
import { BaseMessageAdapter } from "./base.ts";

export class TelegramMessageAdapter extends BaseMessageAdapter {
	readonly source: MessageSource = "telegram";

	isAvailable(runtime: IAgentRuntime): boolean {
		return runtime.getService("telegram") != null;
	}
}
