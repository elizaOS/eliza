/**
 * TALLY_BALLOT_IF_THRESHOLD_MET — atomic action.
 *
 * Asks the cloud client whether the ballot has met its threshold and, if so,
 * computes the tally. The action itself never logs the tally values — only
 * whether the threshold was met and the vote count. Callers that need the
 * actual tally read it from the returned ballot envelope.
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
}

function readParams(options: HandlerOptions | undefined): RawParams {
	if (!options || typeof options !== "object") return {};
	const params = (options as HandlerOptions).parameters;
	return (params && typeof params === "object" ? params : options) as RawParams;
}

export const tallyBallotIfThresholdMetAction: Action = {
	name: "TALLY_BALLOT_IF_THRESHOLD_MET",
	suppressPostActionContinuation: true,
	similes: ["TALLY_SECRET_BALLOT", "CHECK_BALLOT_THRESHOLD"],
	description:
		"Tally a secret ballot if its threshold has been met. Does NOT log tally values; callers read them from the returned ballot envelope.",
	descriptionCompressed: "Tally ballot if threshold met.",
	parameters: [
		{
			name: "ballotId",
			description: "Ballot ID to evaluate.",
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
		return typeof params.ballotId === "string" && params.ballotId.length > 0;
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
				data: { actionName: "TALLY_BALLOT_IF_THRESHOLD_MET" },
			};
		}

		const params = readParams(options);
		const ballotId = typeof params.ballotId === "string" ? params.ballotId : "";
		if (!ballotId) {
			return {
				success: false,
				text: "Missing required parameter: ballotId",
				data: { actionName: "TALLY_BALLOT_IF_THRESHOLD_MET" },
			};
		}

		const outcome = await client.tallyIfThresholdMet({ ballotId });

		const totalVotes = outcome.result?.totalVotes ?? null;
		// Intentionally only log the boolean + counts. Never log values or the
		// per-value count distribution.
		logger.info(
			`[TALLY_BALLOT_IF_THRESHOLD_MET] ballotId=${ballotId} tallied=${outcome.tallied} totalVotes=${totalVotes ?? "n/a"}`,
		);

		const text = outcome.tallied
			? `Ballot ${ballotId} tallied.`
			: `Ballot ${ballotId} has not yet met its threshold.`;
		if (callback) {
			await callback({ text, action: "TALLY_BALLOT_IF_THRESHOLD_MET" });
		}

		return {
			success: true,
			text,
			data: {
				actionName: "TALLY_BALLOT_IF_THRESHOLD_MET",
				ballotId: outcome.ballot.ballotId,
				tallied: outcome.tallied,
				ballot: outcome.ballot,
				// The tally result rides on the ballot envelope (tallyResult).
				// Surfacing it on data.ballot keeps it together with the canonical
				// status without duplicating the structure here.
			},
		};
	},

	examples: [],
};
