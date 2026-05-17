/**
 * EXPIRE_BALLOT — atomic action.
 *
 * Force-expires an open ballot via the cloud client. Useful when an agent
 * decides the collection window is over before the wall-clock TTL.
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

export const expireBallotAction: Action = {
	name: "EXPIRE_BALLOT",
	suppressPostActionContinuation: true,
	similes: ["CLOSE_SECRET_BALLOT", "FORCE_EXPIRE_BALLOT"],
	description: "Force-expire an open secret ballot.",
	descriptionCompressed: "Expire an open ballot.",
	parameters: [
		{
			name: "ballotId",
			description: "Ballot ID to expire.",
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
				data: { actionName: "EXPIRE_BALLOT" },
			};
		}

		const params = readParams(options);
		const ballotId = typeof params.ballotId === "string" ? params.ballotId : "";
		if (!ballotId) {
			return {
				success: false,
				text: "Missing required parameter: ballotId",
				data: { actionName: "EXPIRE_BALLOT" },
			};
		}

		const envelope = await client.expireBallot({ ballotId });

		logger.info(
			`[EXPIRE_BALLOT] ballotId=${envelope.ballotId} status=${envelope.status}`,
		);

		const text = `Ballot ${envelope.ballotId} is now ${envelope.status}.`;
		if (callback) {
			await callback({ text, action: "EXPIRE_BALLOT" });
		}

		return {
			success: envelope.status === "expired",
			text,
			data: {
				actionName: "EXPIRE_BALLOT",
				ballotId: envelope.ballotId,
				status: envelope.status,
			},
		};
	},

	examples: [],
};
