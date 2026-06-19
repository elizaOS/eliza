import type {
	ActionResult,
	HandlerCallback,
	IAgentRuntime,
	Memory,
} from "@elizaos/core";
import { gateDestructiveConfirmation } from "@elizaos/core";

export type LifeOpsConfirmationStatus = "confirmed" | "pending" | "cancelled";

export async function requireLifeOpsUserConfirmation(args: {
	runtime: IAgentRuntime;
	message: Memory;
	actionName: string;
	pendingKey: string;
	prompt: string;
	callback?: HandlerCallback;
}): Promise<LifeOpsConfirmationStatus> {
	const gate = await gateDestructiveConfirmation({
		runtime: args.runtime,
		message: args.message,
		actionName: args.actionName,
		pendingKey: args.pendingKey,
		prompt: `${args.prompt} Reply yes to confirm or no to cancel.`,
		callback: args.callback,
	});
	return gate.status;
}

export function lifeOpsConfirmationBlocked(
	status: "pending" | "cancelled",
	prompt: string,
	extra?: Record<string, unknown>,
): ActionResult {
	if (status === "cancelled") {
		return {
			success: true,
			text: "Cancelled.",
			data: { cancelled: true, ...extra },
		};
	}
	return {
		success: true,
		text: `${prompt} Reply yes to confirm or no to cancel.`,
		data: {
			requiresConfirmation: true,
			draft: true,
			awaitingUserInput: true,
			...extra,
		},
	};
}
