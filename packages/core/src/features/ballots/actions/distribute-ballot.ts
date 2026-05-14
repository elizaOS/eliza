/**
 * DISTRIBUTE_BALLOT — atomic action.
 *
 * Hands the cloud's per-participant tokens to each voter over DM. v1 only
 * supports the DM target; any other target is rejected with a structured
 * error so the planner does not silently fall back to a public delivery.
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
	SECRET_BALLOTS_CLIENT_SERVICE,
	type SecretBallotDistributionTarget,
	type SecretBallotsClient,
} from "../types.ts";

const ALLOWED_TARGETS: ReadonlySet<SecretBallotDistributionTarget> = new Set([
	"dm",
]);

interface RawParams {
	ballotId?: unknown;
	target?: unknown;
}

function readParams(options: HandlerOptions | undefined): RawParams {
	if (!options || typeof options !== "object") return {};
	const params = (options as HandlerOptions).parameters;
	return (params && typeof params === "object" ? params : options) as RawParams;
}

export const distributeBallotAction: Action = {
	name: "DISTRIBUTE_BALLOT",
	suppressPostActionContinuation: true,
	similes: ["DISTRIBUTE_SECRET_BALLOT", "DELIVER_BALLOT_TOKENS"],
	description:
		"Distribute a secret ballot's per-participant tokens. v1 supports the 'dm' target only; non-DM targets are rejected.",
	descriptionCompressed: "Distribute ballot tokens (DM only).",
	parameters: [
		{
			name: "ballotId",
			description: "Ballot ID returned by CREATE_SECRET_BALLOT.",
			required: true,
			schema: { type: "string" as const },
		},
		{
			name: "target",
			description: "Distribution target. Only 'dm' is supported in v1.",
			required: true,
			schema: { type: "string" as const, enum: ["dm"] },
		},
	],

	validate: async (
		runtime: IAgentRuntime,
		_message: Memory,
		_state?: State,
		options?: HandlerOptions,
	): Promise<boolean> => {
		if (runtime.getService(SECRET_BALLOTS_CLIENT_SERVICE) === null)
			return false;
		const params = readParams(options);
		return (
			typeof params.ballotId === "string" &&
			params.ballotId.length > 0 &&
			typeof params.target === "string" &&
			ALLOWED_TARGETS.has(params.target as SecretBallotDistributionTarget)
		);
	},

	handler: async (
		runtime: IAgentRuntime,
		_message: Memory,
		_state?: State,
		options?: HandlerOptions,
		callback?: HandlerCallback,
	) => {
		const client = runtime.getService(
			SECRET_BALLOTS_CLIENT_SERVICE,
		) as unknown as SecretBallotsClient | null;
		if (!client) {
			return {
				success: false,
				text: "SecretBallotsClient not available",
				data: { actionName: "DISTRIBUTE_BALLOT" },
			};
		}

		const params = readParams(options);
		const ballotId = typeof params.ballotId === "string" ? params.ballotId : "";
		const target = typeof params.target === "string" ? params.target : "";

		if (!ballotId) {
			return {
				success: false,
				text: "Missing required parameter: ballotId",
				data: { actionName: "DISTRIBUTE_BALLOT" },
			};
		}

		if (!ALLOWED_TARGETS.has(target as SecretBallotDistributionTarget)) {
			logger.warn(
				`[DISTRIBUTE_BALLOT] rejected non-DM target=${target} ballotId=${ballotId}`,
			);
			return {
				success: false,
				text: `Ballot distribution rejected: target '${target}' is not allowed. Only 'dm' is permitted in v1.`,
				data: {
					actionName: "DISTRIBUTE_BALLOT",
					ballotId,
					rejectedTarget: target,
					reason: "non_dm_target_forbidden",
				},
			};
		}

		const outcome = await client.distribute({
			ballotId,
			target: target as SecretBallotDistributionTarget,
		});

		logger.info(
			`[DISTRIBUTE_BALLOT] ballotId=${outcome.ballotId} target=${outcome.target} dispatched=${outcome.dispatched}`,
		);

		const text = `Distributed ballot ${outcome.ballotId} to ${outcome.dispatched} participant(s) via ${outcome.target}.`;
		if (callback) {
			await callback({ text, action: "DISTRIBUTE_BALLOT" });
		}

		return {
			success: true,
			text,
			data: {
				actionName: "DISTRIBUTE_BALLOT",
				ballotId: outcome.ballotId,
				target: outcome.target,
				dispatched: outcome.dispatched,
			},
		};
	},

	examples: [],
};
