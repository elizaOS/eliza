/**
 * CREATE_SECRET_BALLOT — atomic action.
 *
 * Creates an M-of-N secret ballot via the cloud client. Returns only the
 * ballotId and expiry timestamp; the raw participant tokens never reach the
 * action result. Distribution is a separate atomic action.
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
	type CreateSecretBallotInput,
	SECRET_BALLOTS_CLIENT_SERVICE,
	type SecretBallotParticipant,
	type SecretBallotsClient,
} from "../types.ts";

interface RawParams {
	purpose?: unknown;
	participants?: unknown;
	threshold?: unknown;
	expiresInMs?: unknown;
	metadata?: unknown;
}

function readParams(options: HandlerOptions | undefined): RawParams {
	if (!options || typeof options !== "object") return {};
	const params = (options as HandlerOptions).parameters;
	return (params && typeof params === "object" ? params : options) as RawParams;
}

function parseParticipants(
	raw: unknown,
):
	| { ok: true; participants: SecretBallotParticipant[] }
	| { ok: false; error: string } {
	if (!Array.isArray(raw) || raw.length === 0) {
		return { ok: false, error: "participants must be a non-empty array" };
	}
	const seen = new Set<string>();
	const participants: SecretBallotParticipant[] = [];
	for (const entry of raw) {
		if (!entry || typeof entry !== "object") {
			return { ok: false, error: "participant entries must be objects" };
		}
		const obj = entry as Record<string, unknown>;
		const identityId =
			typeof obj.identityId === "string" ? obj.identityId.trim() : "";
		if (!identityId) {
			return { ok: false, error: "participant.identityId is required" };
		}
		if (seen.has(identityId)) {
			return {
				ok: false,
				error: `duplicate participant identityId: ${identityId}`,
			};
		}
		seen.add(identityId);
		const participant: SecretBallotParticipant = { identityId };
		if (typeof obj.label === "string" && obj.label.trim().length > 0) {
			participant.label = obj.label.trim();
		}
		if (
			typeof obj.channelHint === "string" &&
			obj.channelHint.trim().length > 0
		) {
			participant.channelHint = obj.channelHint.trim();
		}
		participants.push(participant);
	}
	return { ok: true, participants };
}

function buildCreateInput(
	params: RawParams,
): { input: CreateSecretBallotInput } | { error: string } {
	const purpose =
		typeof params.purpose === "string" ? params.purpose.trim() : "";
	if (!purpose) {
		return { error: "Missing or invalid purpose" };
	}
	const parsedParticipants = parseParticipants(params.participants);
	if (!parsedParticipants.ok) {
		return { error: parsedParticipants.error };
	}
	const threshold = params.threshold;
	if (
		typeof threshold !== "number" ||
		!Number.isFinite(threshold) ||
		!Number.isInteger(threshold) ||
		threshold < 1
	) {
		return { error: "threshold must be a positive integer" };
	}
	if (threshold > parsedParticipants.participants.length) {
		return { error: "threshold cannot exceed participant count" };
	}
	const input: CreateSecretBallotInput = {
		purpose,
		participants: parsedParticipants.participants,
		threshold,
	};
	if (
		typeof params.expiresInMs === "number" &&
		Number.isFinite(params.expiresInMs) &&
		params.expiresInMs > 0
	) {
		input.expiresInMs = params.expiresInMs;
	}
	if (
		params.metadata &&
		typeof params.metadata === "object" &&
		!Array.isArray(params.metadata)
	) {
		input.metadata = params.metadata as Record<string, unknown>;
	}
	return { input };
}

export const createSecretBallotAction: Action = {
	name: "CREATE_SECRET_BALLOT",
	suppressPostActionContinuation: true,
	similes: [
		"OPEN_SECRET_BALLOT",
		"START_SECRET_BALLOT",
		"NEW_SECRET_BALLOT",
		"COLLECT_SECRET_VOTES",
	],
	description:
		"Create an M-of-N secret ballot. Returns ballotId and expiresAt; never returns participant tokens.",
	descriptionCompressed:
		"Open secret ballot: purpose, participants, threshold -> ballotId.",
	parameters: [
		{
			name: "purpose",
			description: "Human-readable description of what is being voted on.",
			required: true,
			schema: { type: "string" as const },
		},
		{
			name: "participants",
			description:
				"Array of {identityId, label?, channelHint?} entries; the fixed participant set.",
			required: true,
			schema: { type: "array" as const, items: { type: "object" as const } },
		},
		{
			name: "threshold",
			description:
				"Minimum votes required before the ballot can be tallied. 1..participants.length.",
			required: true,
			schema: { type: "number" as const },
		},
		{
			name: "expiresInMs",
			description: "TTL override in ms. Default 24h.",
			required: false,
			schema: { type: "number" as const },
		},
		{
			name: "metadata",
			description: "Free-form metadata recorded on the ballot.",
			required: false,
			schema: { type: "object" as const },
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
		const built = buildCreateInput(readParams(options));
		return "input" in built;
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
				data: { actionName: "CREATE_SECRET_BALLOT" },
			};
		}

		const params = readParams(options);
		const built = buildCreateInput(params);
		if ("error" in built) {
			logger.warn(`[CREATE_SECRET_BALLOT] invalid params: ${built.error}`);
			return {
				success: false,
				text: built.error,
				data: { actionName: "CREATE_SECRET_BALLOT" },
			};
		}

		const envelope = await client.create(built.input);

		logger.info(
			`[CREATE_SECRET_BALLOT] ballotId=${envelope.ballotId} threshold=${envelope.threshold} participants=${envelope.participants.length}`,
		);

		const text = `Opened secret ballot ${envelope.ballotId} (${envelope.threshold} of ${envelope.participants.length}).`;
		if (callback) {
			await callback({ text, action: "CREATE_SECRET_BALLOT" });
		}

		return {
			success: true,
			text,
			data: {
				actionName: "CREATE_SECRET_BALLOT",
				ballotId: envelope.ballotId,
				expiresAt: envelope.expiresAt,
				threshold: envelope.threshold,
				participantCount: envelope.participants.length,
			},
		};
	},

	examples: [],
};
