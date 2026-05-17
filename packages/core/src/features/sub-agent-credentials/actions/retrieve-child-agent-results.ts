/**
 * RETRIEVE_CHILD_AGENT_RESULTS — atomic action.
 *
 * Pulls the final result bundle (transcript, artifact list, structured
 * result payload) for a completed child coding-agent session. The
 * orchestrator persists these results in the parent's memory after the
 * action returns; this slice only fetches them.
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
	SUB_AGENT_CHILD_RESULTS_CLIENT_SERVICE,
	type SubAgentChildResultsClient,
} from "../types.ts";

interface RetrieveParams {
	childSessionId?: unknown;
}

function readParams(options: HandlerOptions | undefined): RetrieveParams {
	const params = options?.parameters;
	return params && typeof params === "object" ? (params as RetrieveParams) : {};
}

function getClient(runtime: IAgentRuntime): SubAgentChildResultsClient | null {
	return (runtime.getService(SUB_AGENT_CHILD_RESULTS_CLIENT_SERVICE) ??
		null) as unknown as SubAgentChildResultsClient | null;
}

export const retrieveChildAgentResultsAction: Action = {
	name: "RETRIEVE_CHILD_AGENT_RESULTS",
	description:
		"Fetch the final result bundle (transcript, artifacts, structured result) for a child coding-agent session.",
	descriptionCompressed: "Fetch child sub-agent result bundle.",
	suppressPostActionContinuation: true,
	similes: [
		"FETCH_CHILD_AGENT_RESULTS",
		"GET_SUB_AGENT_OUTPUT",
		"COLLECT_CHILD_AGENT_OUTPUT",
	],
	parameters: [
		{
			name: "childSessionId",
			description: "PTY session id of the spawned child coding agent.",
			required: true,
			schema: { type: "string" },
		},
	],

	validate: async (
		runtime: IAgentRuntime,
		_message: Memory,
		_state?: State,
		options?: HandlerOptions,
	): Promise<boolean> => {
		if (!getClient(runtime)) return false;
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
		const client = getClient(runtime);
		if (!client) {
			return {
				success: false,
				text: "SubAgentChildResultsClient service not available",
				data: { actionName: "RETRIEVE_CHILD_AGENT_RESULTS" },
			};
		}
		const params = readParams(options);
		const childSessionId =
			typeof params.childSessionId === "string" ? params.childSessionId : "";
		if (!childSessionId) {
			return {
				success: false,
				text: "Missing required parameter: childSessionId",
				data: { actionName: "RETRIEVE_CHILD_AGENT_RESULTS" },
			};
		}

		const bundle = await client.getResults({ childSessionId });

		logger.info(
			`[SubAgentCreds:retrieve_results] childSessionId=${childSessionId} artifacts=${bundle.artifacts?.length ?? 0}`,
		);

		const text = `Fetched result bundle for ${childSessionId}.`;
		if (callback) {
			await callback({
				text,
				action: "RETRIEVE_CHILD_AGENT_RESULTS",
				content: {
					childSessionId: bundle.childSessionId,
					retrievedAt: bundle.retrievedAt,
					transcript: bundle.transcript,
					artifacts: bundle.artifacts?.map((artifact) => ({
						path: artifact.path,
						bytes: artifact.bytes,
					})),
					result: bundle.result ? JSON.stringify(bundle.result) : undefined,
				},
			});
		}

		return {
			success: true,
			text,
			data: {
				actionName: "RETRIEVE_CHILD_AGENT_RESULTS",
				bundle,
			},
		};
	},

	examples: [],
};
