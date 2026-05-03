import type { IAgentRuntime } from "../../../../types/index.ts";
import type { MessageSource } from "../types.ts";
import { BaseMessageAdapter } from "./base.ts";

export class SignalMessageAdapter extends BaseMessageAdapter {
	readonly source: MessageSource = "signal";

	isAvailable(runtime: IAgentRuntime): boolean {
		return runtime.getService("signal") != null;
	}
}
