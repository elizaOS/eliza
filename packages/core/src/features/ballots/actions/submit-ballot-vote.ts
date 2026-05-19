/**
 * SUBMIT_BALLOT_VOTE — atomic action.
 *
 * Submits a participant's vote via the cloud client. Replays with the same
 * value are idempotent; conflicting values are rejected.
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
	type SecretBallotsClient,
} from "../types.ts";

interface RawParams {
	ballotId?: unknown;
	scopedToken?: unknown;
	value?: unknown;
}

function readParams(options: HandlerOptions | undefined): RawParams {
	if (!options || typeof options !== "object") return {};
	const params = (options as HandlerOptions).parameters;
	return (params && typeof params === "object" ? params : options) as RawParams;
}

export const submitBallotVoteAction: Action = {
	name: "SUBMIT_BALLOT_VOTE",
	suppressPostActionContinuation: true,
	similes: ["CAST_BALLOT_VOTE", "VOTE_IN_BALLOT", "RECORD_BALLOT_VOTE"],
	description:
		"Submit a vote on a secret ballot using a per-participant scoped token. Idempotent on replay with the same value.",
	descriptionCompressed: "Cast a secret-ballot vote with a scoped token.",
	parameters: [
		{
			name: "ballotId",
			description: "Ballot ID.",
			required: true,
			schema: { type: "string" as const },
		},
		{
			name: "scopedToken",
			description: "Per-participant scoped token issued at create time.",
			required: true,
			schema: { type: "string" as const },
		},
		{
			name: "value",
			description: "Plaintext value being voted (v1).",
			required: true,
			schema: { type: "string" as const },
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
			typeof params.scopedToken === "string" &&
			params.scopedToken.length > 0 &&
			typeof params.value === "string" &&
			params.value.length > 0
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
				data: { actionName: "SUBMIT_BALLOT_VOTE" },
			};
		}

		const params = readParams(options);
		const ballotId = typeof params.ballotId === "string" ? params.ballotId : "";
		const scopedToken =
			typeof params.scopedToken === "string" ? params.scopedToken : "";
		const value = typeof params.value === "string" ? params.value : "";

		if (!ballotId || !scopedToken || !value) {
			return {
				success: false,
				text: "Missing required parameters: ballotId, scopedToken, value",
				data: { actionName: "SUBMIT_BALLOT_VOTE" },
			};
		}

		const result = await client.submitVote({ ballotId, scopedToken, value });

		if (!result.ok) {
			logger.warn(
				`[SUBMIT_BALLOT_VOTE] ballotId=${ballotId} rejected reason=${result.reason}`,
			);
			const text = `Vote on ${ballotId} rejected: ${result.reason}.`;
			if (callback) {
				await callback({ text, action: "SUBMIT_BALLOT_VOTE" });
			}
			return {
				success: false,
				text,
				data: {
					actionName: "SUBMIT_BALLOT_VOTE",
					ballotId,
					reason: result.reason,
				},
			};
		}

		logger.info(
			`[SUBMIT_BALLOT_VOTE] ballotId=${ballotId} outcome=${result.outcome}`,
		);

		const text =
			result.outcome === "recorded"
				? `Vote recorded on ballot ${ballotId}.`
				: `Vote already recorded on ballot ${ballotId}; replay accepted.`;
		if (callback) {
			await callback({ text, action: "SUBMIT_BALLOT_VOTE" });
		}

		return {
			success: true,
			text,
			data: {
				actionName: "SUBMIT_BALLOT_VOTE",
				ballotId,
				outcome: result.outcome,
				ballotStatus: result.ballotStatus,
			},
		};
	},

	examples: [],
};
