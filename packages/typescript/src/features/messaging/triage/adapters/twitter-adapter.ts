import type { IAgentRuntime } from "../../../../types/index.ts";
import type { MessageSource } from "../types.ts";
import { BaseMessageAdapter } from "./base.ts";

export class TwitterMessageAdapter extends BaseMessageAdapter {
	readonly source: MessageSource = "twitter";

	isAvailable(runtime: IAgentRuntime): boolean {
		return (
			runtime.getService("twitter") != null ||
			runtime.getService("x") != null
		);
	}
}
