/**
 * AWAIT_APPROVAL — atomic approval action.
 *
 * Blocks until the ApprovalCallbackBus reports a terminal result (approved /
 * denied / expired / canceled) for the given approval request id, or the
 * timeout elapses. Returns a sanitized callback envelope.
 */

import { logger } from "../../../logger.ts";
import type {
	Action,
	HandlerCallback,
	HandlerOptions,
	IAgentRuntime,
	JsonValue,
	Memory,
	State,
} from "../../../types/index.ts";
import {
	APPROVAL_CALLBACK_BUS_CLIENT_SERVICE,
	type ApprovalCallbackBusClient,
} from "../types.ts";

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

interface AwaitApprovalParams {
	approvalRequestId?: unknown;
	timeoutMs?: unknown;
}

function readParams(
	options: HandlerOptions | Record<string, JsonValue | undefined> | undefined,
): AwaitApprovalParams {
	if (!options || typeof options !== "object") return {};
	const params = (options as HandlerOptions).parameters;
	if (params && typeof params === "object") {
		return params as AwaitApprovalParams;
	}
	return options as AwaitApprovalParams;
}

export const awaitApprovalAction: Action = {
	name: "AWAIT_APPROVAL",
	suppressPostActionContinuation: true,
	similes: ["WAIT_FOR_APPROVAL", "AWAIT_APPROVAL_CALLBACK"],
	description:
		"Wait for the approval callback bus to deliver a result for an approval request.",
	descriptionCompressed: "Await approval callback.",
	parameters: [
		{
			name: "approvalRequestId",
			description: "ID of an existing approval request.",
			required: true,
			schema: { type: "string" as const },
		},
		{
			name: "timeoutMs",
			description: "Wait timeout in milliseconds. Defaults to 600000.",
			required: false,
			schema: { type: "number" as const },
		},
	],

	validate: async (
		runtime: IAgentRuntime,
		_message: Memory,
		_state?: State,
		options?: HandlerOptions,
	): Promise<boolean> => {
		const params = readParams(options);
		return (
			runtime.getService(APPROVAL_CALLBACK_BUS_CLIENT_SERVICE) !== null &&
			typeof params.approvalRequestId === "string" &&
			params.approvalRequestId.length > 0
		);
	},

	handler: async (
		runtime: IAgentRuntime,
		_message: Memory,
		_state?: State,
		options?: HandlerOptions,
		callback?: HandlerCallback,
	) => {
		const params = readParams(options);
		const bus = runtime.getService(
			APPROVAL_CALLBACK_BUS_CLIENT_SERVICE,
		) as unknown as ApprovalCallbackBusClient | null;
		if (!bus) {
			return {
				success: false,
				text: "ApprovalCallbackBusClient not available",
				data: { actionName: "AWAIT_APPROVAL" },
			};
		}
		const approvalRequestId =
			typeof params.approvalRequestId === "string"
				? params.approvalRequestId
				: "";
		if (!approvalRequestId) {
			return {
				success: false,
				text: "Missing required parameter: approvalRequestId",
				data: { actionName: "AWAIT_APPROVAL" },
			};
		}

		const timeoutMs =
			typeof params.timeoutMs === "number" &&
			Number.isFinite(params.timeoutMs) &&
			params.timeoutMs > 0
				? params.timeoutMs
				: DEFAULT_TIMEOUT_MS;

		const result = await bus.waitFor(approvalRequestId, timeoutMs);

		logger.info(
			`[AWAIT_APPROVAL] approvalRequestId=${approvalRequestId} status=${result.status}`,
		);

		const sanitized = {
			approvalRequestId: result.approvalRequestId,
			status: result.status,
			signerIdentityId: result.signerIdentityId,
			error: result.error,
			receivedAt: result.receivedAt,
		};

		const text =
			result.status === "approved"
				? `Approval ${approvalRequestId} approved.`
				: `Approval ${approvalRequestId} ended in status ${result.status}${result.error ? `: ${result.error}` : ""}.`;
		if (callback) {
			await callback({ text, action: "AWAIT_APPROVAL" });
		}

		return {
			success: result.status === "approved",
			text,
			data: { actionName: "AWAIT_APPROVAL", callback: sanitized },
		};
	},

	examples: [],
};
