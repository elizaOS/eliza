import { logger } from "../../../logger.ts";
import type {
	ActionResult,
	IAgentRuntime,
	Memory,
	State,
} from "../../../types/index.ts";
import { parseJSONObjectFromText } from "../../../utils.ts";
import type {
	ContextualPermissionSystemServiceWrapper,
	TrustEngineServiceWrapper,
} from "../services/wrappers.ts";
import type { ElevationRequest } from "../types/permissions.ts";

type ActionOptions = Record<string, unknown>;

function readNestedParameters(
	options: ActionOptions | undefined,
): ActionOptions {
	const nested = options?.parameters;
	if (typeof nested === "object" && nested !== null && !Array.isArray(nested)) {
		return nested as ActionOptions;
	}
	return {};
}

export async function requestElevationHandler(
	runtime: IAgentRuntime,
	message: Memory,
	_state: State | undefined,
	options: ActionOptions | undefined,
): Promise<ActionResult> {
	const permissionSystemService =
		runtime.getService<ContextualPermissionSystemServiceWrapper>(
			"contextual-permissions",
		);
	const trustEngineService =
		runtime.getService<TrustEngineServiceWrapper>("trust-engine");

	if (!permissionSystemService || !trustEngineService) {
		return {
			success: false,
			text: "Required trust services are not available.",
			error: "Required services not available",
			data: { actionName: "TRUST", subaction: "request_elevation" },
		};
	}

	const params = readNestedParameters(options);
	const text = message.content.text || "";
	let parsed: Record<string, unknown> | null = null;
	try {
		parsed = parseJSONObjectFromText(text);
	} catch {
		// Not JSON
	}
	const requestData = { ...(parsed ?? {}), ...params } as {
		action?: string;
		permissionAction?: string;
		resource?: string;
		justification?: string;
		duration?: number;
	};

	// The umbrella's discriminator is `action` — when this handler is invoked
	// via the umbrella, `action` carries the subaction ("request_elevation"),
	// not the permission action. Prefer the explicit `permissionAction` field;
	// only fall back to `action` if it isn't the subaction discriminator.
	const permissionAction =
		requestData.permissionAction ??
		(requestData.action && requestData.action !== "request_elevation"
			? requestData.action
			: undefined);

	if (!permissionAction) {
		return {
			success: false,
			text: 'Please specify the permissionAction you need elevated permissions for. Example: "I need to manage roles to help moderate the channel"',
			error: "No permission action specified",
			data: { actionName: "TRUST", subaction: "request_elevation" },
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
			action: permissionAction,
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

		if (result.granted) {
			const expiryTime = result.expiresAt
				? new Date(result.expiresAt).toLocaleString()
				: "session end";
			return {
				success: true,
				text: `Elevation approved! You have been granted temporary ${permissionAction} permissions until ${expiryTime}.

Please use these permissions responsibly. All actions will be logged for audit.`,
				data: {
					actionName: "TRUST",
					subaction: "request_elevation",
					approved: true,
					expiresAt: result.expiresAt,
				},
			};
		}

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
				actionName: "TRUST",
				subaction: "request_elevation",
				approved: false,
				reason: result.reason,
				currentTrust: trustProfile.overallTrust,
			},
		};
	} catch (error) {
		logger.error(
			{ error },
			"[RequestElevation] Error processing elevation request:",
		);
		return {
			success: false,
			text: "Failed to process elevation request. Please try again.",
			error: error instanceof Error ? error.message : "Unknown error",
			data: { actionName: "TRUST", subaction: "request_elevation" },
		};
	}
}
