/**
 * AWAIT_CHILD_AGENT_DECISION — atomic action.
 *
 * Subscribes to the named child session's universal DECISION channel and
 * resolves as soon as the child emits a decision line. The parent planner
 * uses this to gate the next step (e.g. cancel the credential scope if the
 * child decided "abort", forward the decision to the user, etc.).
 *
 * The decision line itself is surfaced verbatim — callers must sanitize it
 * before persisting if they suspect leaked secrets. The action never logs
 * the raw line.
 */

import { logger } from "../../../logger.ts";
import type {
	Action,
	HandlerCallback,
	HandlerOptions,
	IAgentRuntime,
	Memory,
	State,
} from "../../../types/index.ts";
import {
	SUB_AGENT_CHILD_DECISION_BUS_SERVICE,
	type SubAgentChildDecisionBus,
} from "../types.ts";

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

interface AwaitParams {
	childSessionId?: unknown;
	timeoutMs?: unknown;
}

function readParams(options: HandlerOptions | undefined): AwaitParams {
	const params = options?.parameters;
	return params && typeof params === "object" ? (params as AwaitParams) : {};
}

function getBus(runtime: IAgentRuntime): SubAgentChildDecisionBus | null {
	return (runtime.getService(SUB_AGENT_CHILD_DECISION_BUS_SERVICE) ??
		null) as unknown as SubAgentChildDecisionBus | null;
}

export const awaitChildAgentDecisionAction: Action = {
	name: "AWAIT_CHILD_AGENT_DECISION",
	description:
		"Wait for the named child coding agent to emit a decision line on its DECISION channel.",
	descriptionCompressed:
		"Block on a child coding agent's next DECISION line (with timeout).",
	suppressPostActionContinuation: true,
	similes: [
		"WAIT_FOR_CHILD_DECISION",
		"BLOCK_ON_CHILD_DECISION",
		"AWAIT_SUB_AGENT_DECISION",
	],
	parameters: [
		{
			name: "childSessionId",
			description: "PTY session id of the spawned child coding agent.",
			required: true,
			schema: { type: "string" },
		},
		{
			name: "timeoutMs",
			description:
				"Wait timeout in ms. Defaults to 600000 (10 minutes). Use longer values only for long-running tasks.",
			required: false,
			schema: { type: "number" },
		},
	],

	validate: async (
		runtime: IAgentRuntime,
		_message: Memory,
		_state?: State,
		options?: HandlerOptions,
	): Promise<boolean> => {
		if (!getBus(runtime)) return false;
		const params = readParams(options);
		return (
			typeof params.childSessionId === "string" &&
			params.childSessionId.length > 0
		);
	},

	handler: async (
		runtime: IAgentRuntime,
		_message: Memory,
		_state?: State,
		options?: HandlerOptions,
		callback?: HandlerCallback,
	) => {
		const bus = getBus(runtime);
		if (!bus) {
			return {
				success: false,
				text: "SubAgentChildDecisionBus service not available",
				data: { actionName: "AWAIT_CHILD_AGENT_DECISION" },
			};
		}
		const params = readParams(options);
		const childSessionId =
			typeof params.childSessionId === "string" ? params.childSessionId : "";
		if (!childSessionId) {
			return {
				success: false,
				text: "Missing required parameter: childSessionId",
				data: { actionName: "AWAIT_CHILD_AGENT_DECISION" },
			};
		}
		const timeoutMs =
			typeof params.timeoutMs === "number" &&
			Number.isFinite(params.timeoutMs) &&
			params.timeoutMs > 0
				? params.timeoutMs
				: DEFAULT_TIMEOUT_MS;

		const decision = await bus.awaitDecision({ childSessionId, timeoutMs });

		logger.info(
			`[SubAgentCreds:await_decision] childSessionId=${childSessionId} decidedAt=${decision.decidedAt}`,
		);

		const text = `Child ${childSessionId} emitted a decision.`;
		if (callback) {
			await callback({
				text,
				action: "AWAIT_CHILD_AGENT_DECISION",
				content: {
					childSessionId: decision.childSessionId,
					decidedAt: decision.decidedAt,
					decision: decision.decision,
					payload: decision.payload
						? JSON.stringify(decision.payload)
						: undefined,
				},
			});
		}

		return {
			success: true,
			text,
			data: {
				actionName: "AWAIT_CHILD_AGENT_DECISION",
				decision,
			},
		};
	},

	examples: [],
};
