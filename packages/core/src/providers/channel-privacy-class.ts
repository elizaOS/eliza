/**
 * Channel Privacy Class Provider
 *
 * Surfaces a planner-friendly classification of the current channel's
 * privacy: `dm | public | api | owner_app_private | unknown`. Uses the
 * canonical `classifySensitiveRequestSource` helper so the answer matches
 * the sensitive-request policy layer exactly.
 *
 * Position: -10 (mirrors the secrets-status planner gate).
 */

import { classifySensitiveRequestSource } from "../sensitive-request-policy.ts";
import type {
	IAgentRuntime,
	Memory,
	Provider,
	ProviderResult,
	State,
} from "../types/index.ts";

export const channelPrivacyClassProvider: Provider = {
	name: "CHANNEL_PRIVACY_CLASS",
	description:
		"Classifies the current channel's privacy (dm, public, api, owner_app_private, unknown).",
	position: -10,
	dynamic: true,
	contexts: ["general", "agent_internal"],
	contextGate: { anyOf: ["general", "agent_internal"] },
	cacheStable: false,
	cacheScope: "turn",
	roleGate: { minRole: "USER" },

	get: async (
		_runtime: IAgentRuntime,
		message: Memory,
		_state?: State,
	): Promise<ProviderResult> => {
		const channelType = message.content.channelType;
		const channelPrivacy = classifySensitiveRequestSource({
			channelType:
				typeof channelType === "string" ? channelType : undefined,
		});
		const channelId =
			typeof message.roomId === "string" ? message.roomId : undefined;

		const text = `[Channel Privacy] ${channelPrivacy}${
			channelId ? ` (channelId=${channelId})` : ""
		}`;

		return {
			text,
			data: { channelPrivacy, channelId },
			values: { channelPrivacy },
		};
	},
};

export default channelPrivacyClassProvider;
