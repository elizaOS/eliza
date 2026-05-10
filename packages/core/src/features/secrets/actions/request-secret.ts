import { logger } from "../../../logger.ts";
import { extractSecretRequestTemplate as extractRequestTemplate } from "../../../prompts.ts";
import {
	resolveSensitiveRequestDelivery,
	type SensitiveRequestDeliveryPlan,
	sensitiveRequestEnvironmentFromSettings,
} from "../../../sensitive-request-policy.ts";
import {
	type Action,
	type ActionExample,
	ChannelType,
	type HandlerCallback,
	type HandlerOptions,
	type IAgentRuntime,
	type Memory,
	ModelType,
	type State,
} from "../../../types/index.ts";
import type { JsonObject } from "../../../types/primitives.ts";
import { hasActionContext } from "../../../utils/action-validation.ts";
import {
	SECRETS_SERVICE_TYPE,
	type SecretsService,
} from "../services/secrets.ts";

export const requestSecretAction: Action = {
	name: "REQUEST_SECRET",
	contexts: ["secrets", "settings", "connectors"],
	roleGate: { minRole: "OWNER" },
	suppressPostActionContinuation: true,
	similes: [
		"ASK_FOR_SECRET",
		"REQUIRE_SECRET",
		"NEED_SECRET",
		"MISSING_SECRET",
	],
	description: "Request a missing secret from the user or administrator",
	parameters: [
		{
			name: "key",
			description:
				"Name of the missing secret, usually UPPERCASE_WITH_UNDERSCORES.",
			required: false,
			schema: { type: "string" as const },
		},
		{
			name: "reason",
			description: "Why the secret is needed.",
			required: false,
			schema: { type: "string" as const },
		},
	],

	validate: async (
		runtime: IAgentRuntime,
		message: Memory,
		_state?: State,
		_options?: HandlerOptions,
	): Promise<boolean> => {
		if (!runtime.getService<SecretsService>(SECRETS_SERVICE_TYPE)) {
			return false;
		}
		const params =
			_options?.parameters && typeof _options.parameters === "object"
				? (_options.parameters as Record<string, unknown>)
				: {};
		const hasStructuredKey =
			typeof params.key === "string" && params.key.trim().length > 0;
		return (
			hasStructuredKey ||
			hasActionContext(message, _state, {
				contexts: ["secrets", "settings", "connectors"],
			})
		);
	},

	handler: async (
		runtime: IAgentRuntime,
		message: Memory,
		state?: State,
		_options?: HandlerOptions,
		callback?: HandlerCallback,
	) => {
		logger.info("[RequestSecret] Processing secret request");

		const currentState = state ?? (await runtime.composeState(message));

		const params =
			_options?.parameters && typeof _options.parameters === "object"
				? (_options.parameters as Record<string, unknown>)
				: {};

		try {
			const result = await runtime.dynamicPromptExecFromState({
				state: currentState,
				params: {
					prompt: extractRequestTemplate,
				},
				schema: [
					{
						field: "key",
						description:
							"Name of the missing secret, usually UPPERCASE_WITH_UNDERSCORES",
						required: false,
						validateField: false,
						streamField: false,
					},
					{
						field: "reason",
						description: "Why the secret is needed",
						required: false,
						validateField: false,
						streamField: false,
					},
				],
				options: {
					modelType: ModelType.TEXT_SMALL,
					contextCheckLevel: 0,
					maxRetries: 1,
				},
			});

			const rawKey = params.key ?? result?.key;
			if (!rawKey) {
				logger.warn(
					"[RequestSecret] Failed to extract secret key from context",
				);
				return {
					success: false,
					text: "Failed to identify the required secret.",
					data: { actionName: "REQUEST_SECRET" },
				};
			}

			const key = String(rawKey)
				.toUpperCase()
				.replace(/[^A-Z0-9_]/g, "_");

			// Check if it already exists
			const service = runtime.getService<SecretsService>(SECRETS_SERVICE_TYPE);
			if (service) {
				const exists = await service.exists(key, {
					level: "global", // Check global/user level
					agentId: runtime.agentId,
					userId:
						message.entityId !== runtime.agentId
							? String(message.entityId)
							: undefined,
				});

				if (exists) {
					const text = `The secret '${key}' is already available. You can use it now.`;
					if (callback) await callback({ text, action: "REQUEST_SECRET" });
					return {
						success: true,
						text,
						data: { actionName: "REQUEST_SECRET", key, exists: true },
					};
				}
			}

			const reason =
				typeof params.reason === "string" && params.reason.trim()
					? params.reason.trim()
					: typeof result?.reason === "string" && result.reason.trim()
						? result.reason.trim()
						: undefined;
			const delivery = resolveSensitiveRequestDelivery({
				kind: "secret",
				channelType: message.content.channelType,
				environment: buildSecretRequestEnvironment(runtime, message, params),
			});
			const text = buildSecretRequestText(key, reason, delivery);

			if (callback) {
				await callback({
					text,
					action: "REQUEST_SECRET",
					content: {
						secretRequest: {
							key,
							reason,
							delivery: toJsonObject(delivery),
						},
					},
				});
			}

			return {
				success: true,
				text,
				data: { actionName: "REQUEST_SECRET", key, exists: false },
			};
		} catch (error) {
			logger.error("[RequestSecret] Error:", String(error));
			return {
				success: false,
				text: "Failed to process secret request",
				error: error instanceof Error ? error.message : String(error),
				data: { actionName: "REQUEST_SECRET" },
			};
		}
	},

	examples: [
		[
			{
				name: "{{user1}}",
				content: { text: "I need an OpenAI key to continue." },
			},
			{
				name: "{{agent}}",
				content: {
					text: "I require the secret 'OPENAI_API_KEY' to proceed. Please provide it securely using 'set secret OPENAI_API_KEY <value>'.",
					action: "REQUEST_SECRET",
				},
			},
		],
		[
			{
				name: "{{user1}}",
				content: {
					text: "I cannot access the database without a connection string.",
				},
			},
			{
				name: "{{agent}}",
				content: {
					text: "I require the secret 'DATABASE_URL' to proceed (database access). Please provide it securely using 'set secret DATABASE_URL <value>'.",
					action: "REQUEST_SECRET",
				},
			},
		],
	] as ActionExample[][],
};

function runtimeSetting(runtime: IAgentRuntime, key: string): unknown {
	try {
		return runtime.getSetting(key);
	} catch {
		return undefined;
	}
}

function buildSecretRequestEnvironment(
	runtime: IAgentRuntime,
	message: Memory,
	params: Record<string, unknown>,
) {
	const tunnelService = runtime.getService("tunnel") as {
		getStatus?: () => {
			active?: boolean;
			url?: string | null;
		};
		getUrl?: () => string | null;
		isActive?: () => boolean;
	} | null;
	const tunnelStatus = tunnelService?.getStatus?.();
	const tunnelUrl =
		typeof tunnelStatus?.url === "string"
			? tunnelStatus.url
			: tunnelService?.getUrl?.();
	const tunnelActive =
		tunnelStatus?.active ?? tunnelService?.isActive?.() ?? false;
	const ownerAppPrivateChat =
		params.ownerAppPrivateChat === true ||
		(message.content.channelType === ChannelType.DM &&
			["app", "in_app", "eliza_app", "owner_app"].includes(
				String(message.content.source ?? "").toLowerCase(),
			));

	return sensitiveRequestEnvironmentFromSettings({
		cloudApiKey: runtimeSetting(runtime, "ELIZAOS_CLOUD_API_KEY"),
		cloudEnabled: runtimeSetting(runtime, "ELIZAOS_CLOUD_ENABLED"),
		cloudBaseUrl:
			runtimeSetting(runtime, "ELIZAOS_CLOUD_REQUEST_BASE_URL") ??
			runtimeSetting(runtime, "ELIZAOS_CLOUD_BASE_URL"),
		tunnelActive,
		tunnelUrl,
		tunnelAuthenticated:
			params.tunnelAuthenticated ??
			runtimeSetting(runtime, "ELIZA_TUNNEL_SENSITIVE_REQUEST_AUTH"),
		dmAvailable: params.dmAvailable ?? true,
		ownerAppPrivateChat,
	});
}

function toJsonObject(value: unknown): JsonObject {
	return JSON.parse(JSON.stringify(value)) as JsonObject;
}

function buildSecretRequestText(
	key: string,
	reason: string | undefined,
	delivery: SensitiveRequestDeliveryPlan,
): string {
	const reasonText = reason ? ` (${reason})` : "";
	const prefix = `I need ${key}${reasonText}.`;

	switch (delivery.mode) {
		case "inline_owner_app":
			return `${prefix} I can collect it in this owner-only app chat and will only show the setup status here.`;
		case "cloud_authenticated_link":
			return `${prefix} Use the authenticated Eliza Cloud setup link when it appears. Do not paste the value into a public channel.`;
		case "tunnel_authenticated_link":
			return `${prefix} Use the authenticated local tunnel setup link when it appears. Do not paste the value into a public channel.`;
		case "private_dm":
			return `${prefix} This is a private channel, so you can set it here if needed, but a secure form is preferred when available.`;
		case "public_link":
			return `${prefix} A public link is not allowed for secret collection. I will use a private or authenticated route instead.`;
		case "dm_or_owner_app_instruction":
			return `${prefix} I cannot collect secrets in this channel. Please DM me or open the owner app to enter it securely.`;
	}
}
