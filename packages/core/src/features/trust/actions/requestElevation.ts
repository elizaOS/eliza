import { logger } from "../../../logger.ts";
import type {
	Action as ElizaAction,
	IAgentRuntime,
	Memory,
	State,
} from "../../../types/index.ts";
import { hasActionContextOrKeyword } from "../../../utils/action-validation.ts";
import { parseJSONObjectFromText } from "../../../utils.ts";
import type {
	ContextualPermissionSystemServiceWrapper,
	TrustEngineServiceWrapper,
} from "../services/wrappers.ts";
import type { ElevationRequest } from "../types/permissions.ts";

export const requestElevationAction: ElizaAction = {
	name: "REQUEST_ELEVATION",
	contexts: ["admin", "settings", "agent_internal"],
	roleGate: { minRole: "USER" },
	description:
		"Request temporary elevation of permissions for a specific action",
	suppressPostActionContinuation: true,
	parameters: [
		{
			name: "action",
			description: "Permission action being requested.",
			required: true,
			schema: { type: "string" as const },
		},
		{
			name: "resource",
			description: "Resource scope for the permission request.",
			required: false,
			schema: { type: "string" as const },
		},
		{
			name: "justification",
			description: "Reason elevation is needed.",
			required: false,
			schema: { type: "string" as const },
		},
		{
			name: "duration",
			description: "Requested duration in hours. Defaults to 60.",
			required: false,
			schema: { type: "number" as const, minimum: 1, maximum: 168 },
		},
	],

	validate: async (
		runtime: IAgentRuntime,
		message: Memory,
		state?: State,
		options?: Record<string, unknown>,
	): Promise<boolean> => {
		try {
			if (!runtime.getService("contextual-permissions")) return false;
			const params =
				options?.parameters && typeof options.parameters === "object"
					? (options.parameters as Record<string, unknown>)
					: {};
			const hasStructuredAction =
				typeof params.action === "string" && params.action.trim().length > 0;
			return (
				hasStructuredAction ||
				hasActionContextOrKeyword(message, state, {
					contexts: ["admin", "settings", "agent_internal"],
					keywords: [
						"request elevation",
						"elevate permissions",
						"temporary access",
						"grant me access",
						"need permission",
					],
				})
			);
		} catch {
			return false;
		}
	},

	handler: async (runtime: IAgentRuntime, message: Memory, _state, options) => {
		const permissionSystemService =
			runtime.getService<ContextualPermissionSystemServiceWrapper>(
				"contextual-permissions",
			);
		const trustEngineService =
			runtime.getService<TrustEngineServiceWrapper>("trust-engine");

		if (!permissionSystemService || !trustEngineService) {
			throw new Error("Required services not available");
		}

		const params =
			options?.parameters && typeof options.parameters === "object"
				? (options.parameters as Record<string, unknown>)
				: {};
		const text = message.content.text || "";
		let parsed: Record<string, unknown> | null = null;
		try {
			parsed = parseJSONObjectFromText(text);
		} catch {
			// Not JSON
		}
		const requestData = { ...(parsed ?? {}), ...params } as {
			action?: string;
			resource?: string;
			justification?: string;
			duration?: number;
		};

		if (!requestData.action) {
			return {
				success: false,
				text: 'Please specify the action you need elevated permissions for. Example: "I need to manage roles to help moderate the channel"',
				error: "No action specified",
				data: { actionName: "REQUEST_ELEVATION" },
			};
		}

		const trustProfile = await trustEngineService.trustEngine.evaluateTrust(
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
			const result =
				await permissionSystemService.permissionSystem.requestElevation(
					elevationRequest,
				);

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

				const suggestions = result.suggestions?.slice(0, 5) ?? [];
				if (suggestions.length > 0) {
					denialMessage += `\n\nSuggestions:\n${suggestions.map((s: string) => `- ${s}`).join("\n")}`;
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
