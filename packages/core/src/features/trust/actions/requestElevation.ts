import { logger } from "../../../logger.ts";
import type {
	Action as ElizaAction,
	IAgentRuntime,
	Memory,
} from "../../../types/index.ts";
import { parseJSONObjectFromText } from "../../../utils.ts";
import type { ElevationRequest } from "../types/permissions.ts";

export const requestElevationAction: ElizaAction = {
	name: "REQUEST_ELEVATION",
	description:
		"Request temporary elevation of permissions for a specific action",
	suppressPostActionContinuation: true,

	validate: async (
		runtime: IAgentRuntime,
		message: Memory,
		state?: unknown,
		options?: Record<string, unknown>,
	): Promise<boolean> => {
		const __avTextRaw =
			typeof message?.content?.text === "string" ? message.content.text : "";
		const __avText = __avTextRaw.toLowerCase();
		const __avLegacyContextOk = Boolean(
			runtime?.getService?.("contextual-permissions"),
		);
		const __avKeywords = ["request", "elevation"];
		const __avKeywordOk =
			__avKeywords.length > 0 &&
			(__avKeywords.some(
				(word) => word.length > 0 && __avText.includes(word),
			) ||
				__avLegacyContextOk);
		const __avRegex = /\b(?:request|elevation)\b/i;
		const __avRegexOk = __avRegex.test(__avText) || __avLegacyContextOk;
		const __avSource = String(message?.content?.source ?? "");
		const __avExpectedSource = "";
		const __avSourceOk = __avExpectedSource
			? __avSource === __avExpectedSource
			: Boolean(
					__avSource ||
						state ||
						runtime?.agentId ||
						runtime?.getService ||
						runtime?.getSetting,
				);
		const __avOptions = options && typeof options === "object" ? options : {};
		const __avInputOk =
			__avText.trim().length > 0 ||
			Object.keys(__avOptions as Record<string, unknown>).length > 0 ||
			Boolean(message?.content && typeof message.content === "object");

		if (!(__avKeywordOk && __avRegexOk && __avSourceOk && __avInputOk)) {
			return false;
		}

		const __avLegacyValidate = async (
			legacyRuntime: IAgentRuntime,
			_legacyMessage: Memory,
			_legacyState?: unknown,
			_legacyOptions?: Record<string, unknown>,
		): Promise<boolean> => {
			const permissionSystem = legacyRuntime.getService(
				"contextual-permissions",
			);
			return !!permissionSystem;
		};
		try {
			return Boolean(
				await __avLegacyValidate(runtime, message, state, options),
			);
		} catch {
			return false;
		}
	},

	handler: async (runtime: IAgentRuntime, message: Memory) => {
		const permissionSystem = runtime.getService(
			"contextual-permissions",
		) as unknown as {
			requestElevation: (request: ElevationRequest) => Promise<{
				allowed: boolean;
				ttl?: number;
				method?: string;
				reason?: string;
				suggestions?: string[];
			}>;
		} | null;
		const trustEngine = runtime.getService("trust-engine") as unknown as {
			evaluateTrust: (
				entityId: unknown,
				evaluatorId: unknown,
				context?: Record<string, unknown>,
			) => Promise<{ overallTrust: number }>;
		} | null;

		if (!permissionSystem || !trustEngine) {
			throw new Error("Required services not available");
		}

		const text = message.content.text || "";
		let parsed: Record<string, unknown> | null = null;
		try {
			parsed = parseJSONObjectFromText(text);
		} catch {
			// Not JSON
		}
		const requestData = parsed as {
			action?: string;
			resource?: string;
			justification?: string;
			duration?: number;
		} | null;

		if (!requestData?.action) {
			return {
				success: false,
				text: 'Please specify the action you need elevated permissions for. Example: "I need to manage roles to help moderate the channel"',
				error: "No action specified",
				data: { actionName: "REQUEST_ELEVATION" },
			};
		}

		const trustProfile = await trustEngine.evaluateTrust(
			message.entityId,
			runtime.agentId,
			{
				roomId: message.roomId,
			},
		);

		const elevationRequest: ElevationRequest = {
			entityId: message.entityId,
			requestedPermission: {
				action: requestData.action,
				resource: requestData.resource || "*",
			},
			justification: requestData.justification || text,
			context: {
				roomId: message.roomId,
				platform: "discord",
			},
			duration: (requestData.duration || 60) * 60 * 1000,
		};

		try {
			const result = await permissionSystem.requestElevation(elevationRequest);

			if (result.allowed) {
				const expiryTime = result.ttl
					? new Date(Date.now() + result.ttl).toLocaleString()
					: "session end";
				return {
					success: true,
					text: `Elevation approved! You have been granted temporary ${requestData.action} permissions until ${expiryTime}.

Please use these permissions responsibly. All actions will be logged for audit.`,
					data: {
						actionName: "REQUEST_ELEVATION",
						approved: true,
						expiresAt: result.ttl ? Date.now() + result.ttl : undefined,
						method: result.method,
					},
				};
			} else {
				let denialMessage = `Elevation request denied: ${result.reason}`;

				denialMessage += `\n\nYour current trust score is ${trustProfile.overallTrust}/100.`;

				if (result.suggestions && result.suggestions.length > 0) {
					denialMessage += `\n\nSuggestions:\n${result.suggestions.map((s: string) => `- ${s}`).join("\n")}`;
				}

				return {
					success: false,
					text: denialMessage,
					data: {
						actionName: "REQUEST_ELEVATION",
						approved: false,
						reason: result.reason,
						currentTrust: trustProfile.overallTrust,
					},
				};
			}
		} catch (error) {
			logger.error(
				{ error },
				"[RequestElevation] Error processing elevation request:",
			);
			return {
				success: false,
				text: "Failed to process elevation request. Please try again.",
				error: error instanceof Error ? error.message : "Unknown error",
				data: { actionName: "REQUEST_ELEVATION" },
			};
		}
	},

	examples: [
		[
			{
				name: "{{name1}}",
				content: {
					text: "I need permission to manage roles to help moderate spam in the channel",
				},
			},
			{
				name: "{{name2}}",
				content: {
					text: "Elevation approved! You have been granted temporary manage_roles permissions until 12/20/2024, 5:30:00 PM.\n\nPlease use these permissions responsibly. All actions will be logged for audit.",
				},
			},
		],
		[
			{
				name: "{{name1}}",
				content: {
					text: "Grant me admin access",
				},
			},
			{
				name: "{{name2}}",
				content: {
					text: "Elevation request denied: Insufficient justification provided\n\nYour current trust score is 45/100. You need 15 more trust points for this permission.\n\nSuggestions:\n- Provide a specific justification for why you need admin access\n- Build trust through consistent positive contributions\n- Request more specific permissions instead of full admin access",
				},
			},
		],
	],

	similes: [
		"request elevated permissions",
		"need temporary access",
		"request higher privileges",
		"need admin permission",
		"elevate my permissions",
		"grant me access",
		"temporary permission request",
		"need special access",
	],
};
