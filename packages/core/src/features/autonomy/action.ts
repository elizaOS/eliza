/**
 * Autonomy Actions for elizaOS
 *
 * Actions that enable autonomous agent communication.
 */

import { v4 as uuidv4 } from "uuid";
import {
	CANONICAL_SUBACTION_KEY,
	DEFAULT_SUBACTION_KEYS,
	normalizeSubaction,
} from "../../actions/subaction-dispatch";
import type {
	Action,
	ActionResult,
	HandlerCallback,
	HandlerOptions,
	IAgentRuntime,
	JsonValue,
	Memory,
	State,
} from "../../types";
import { stringToUuid } from "../../utils";
import { AUTONOMY_SERVICE_TYPE, type AutonomyService } from "./service";

const ESCALATE_SUBACTIONS = ["admin", "owner", "third_party"] as const;
type EscalateSubaction = (typeof ESCALATE_SUBACTIONS)[number];

function readEscalateSubaction(
	options: HandlerOptions | undefined,
): EscalateSubaction {
	const params = options?.parameters as
		| Record<string, JsonValue | undefined>
		| undefined;
	for (const key of DEFAULT_SUBACTION_KEYS) {
		const normalized = normalizeSubaction(params?.[key]);
		if (
			normalized &&
			(ESCALATE_SUBACTIONS as readonly string[]).includes(normalized)
		) {
			return normalized as EscalateSubaction;
		}
	}
	return "admin";
}

function readEscalationMessage(
	options: HandlerOptions | undefined,
): string | null {
	const params = options?.parameters as
		| Record<string, JsonValue | undefined>
		| undefined;
	const value = params?.message;
	if (typeof value !== "string") {
		return null;
	}
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : null;
}

function unsupportedEscalationTarget(
	subaction: Exclude<EscalateSubaction, "admin">,
): ActionResult {
	const text = `ESCALATE action=${subaction} is not supported by the core autonomy action; configure a plugin-owned escalation action for that target.`;
	return {
		success: false,
		text,
		error: text,
		data: {
			actionName: "ESCALATE",
			[CANONICAL_SUBACTION_KEY]: subaction,
			errorCode: "unsupported_escalation_target",
		},
	};
}

async function escalateToAdmin(
	runtime: IAgentRuntime,
	message: Memory,
	options: HandlerOptions | undefined,
	callback: HandlerCallback | undefined,
): Promise<ActionResult> {
	// Double-check we're in autonomous context
	const autonomyService = runtime.getService<AutonomyService>(
		AUTONOMY_SERVICE_TYPE,
	);
	if (!autonomyService) {
		return {
			success: false,
			text: "Autonomy service not available",
			data: { error: "Service unavailable" },
		};
	}

	const autonomousRoomId = autonomyService.getAutonomousRoomId();
	if (!autonomousRoomId || message.roomId !== autonomousRoomId) {
		return {
			success: false,
			text: "Escalate to admin only available in autonomous context",
			data: { error: "Invalid context" },
		};
	}

	// Get admin user ID
	const adminUserId = runtime.getSetting("ADMIN_USER_ID");
	if (typeof adminUserId !== "string" || adminUserId.length === 0) {
		return {
			success: false,
			text: "No admin user configured. Set ADMIN_USER_ID in settings.",
			data: { error: "No admin configured" },
		};
	}

	const targetRoomId = runtime.agentId;
	const autonomousThought = message.content.text || "";
	const messageToAdmin = readEscalationMessage(options) ?? autonomousThought;

	// Create and store message
	const now = Date.now();
	const adminMessage: Memory = {
		id: stringToUuid(uuidv4()),
		entityId: runtime.agentId,
		roomId: targetRoomId,
		content: {
			text: messageToAdmin,
			source: "autonomy-to-admin",
			metadata: {
				type: "autonomous-to-admin-message",
				originalThought: autonomousThought,
				timestamp: now,
			},
		},
		createdAt: now,
	};

	await runtime.createMemory(adminMessage, "memories");

	const successMessage = `Message sent to admin in room ${targetRoomId.slice(0, 8)}...`;

	if (callback) {
		await callback({
			text: successMessage,
			data: {
				adminUserId,
				targetRoomId,
				messageContent: messageToAdmin,
			},
		});
	}

	return {
		success: true,
		text: successMessage,
		data: {
			adminUserId,
			targetRoomId,
			messageContent: messageToAdmin,
			sent: true,
			[CANONICAL_SUBACTION_KEY]: "admin",
		},
	};
}

/**
 * Escalate Action
 *
 * Allows an autonomous agent to escalate a message to a human. The core action
 * supports the configured `admin` target; owner and third-party escalation
 * targets belong in plugin-owned actions with their own delivery contracts.
 */
export const escalateAction: Action = {
	name: "ESCALATE",
	contexts: ["admin", "messaging", "agent_internal"],
	roleGate: { minRole: "ADMIN" },
	description:
		"Escalate from autonomous context to a human. action=admin sends to the configured admin; owner/third_party return an explicit unsupported-target result unless a plugin provides its own route.",
	similes: ["SEND_TO_ADMIN"],
	parameters: [
		{
			name: "action",
			description:
				"Escalation target: admin | owner | third_party. Defaults to admin when omitted.",
			required: false,
			schema: {
				type: "string",
				enum: [...ESCALATE_SUBACTIONS],
			},
		},
		{
			name: "message",
			description: "Optional message to send to the escalation target.",
			required: false,
			schema: { type: "string" },
		},
	],

	examples: [
		[
			{
				name: "Agent",
				content: {
					text: "I need to update the admin about my progress on the task.",
					action: "ESCALATE",
				},
			},
			{
				name: "Agent",
				content: {
					text: "Message sent to admin successfully.",
				},
			},
		],
		[
			{
				name: "Agent",
				content: {
					text: "I should let the admin know I completed the analysis.",
					action: "ESCALATE",
				},
			},
			{
				name: "Agent",
				content: {
					text: "Admin has been notified of the analysis completion.",
				},
			},
		],
	],

	validate: async (
		runtime: IAgentRuntime,
		message: Memory,
	): Promise<boolean> => {
		// Only allow this action in autonomous context
		const autonomyService = runtime.getService<AutonomyService>(
			AUTONOMY_SERVICE_TYPE,
		);
		if (!autonomyService) {
			return false;
		}

		const autonomousRoomId = autonomyService.getAutonomousRoomId();
		if (!autonomousRoomId || message.roomId !== autonomousRoomId) {
			return false;
		}

		// Check if admin is configured
		const adminUserId = runtime.getSetting("ADMIN_USER_ID");
		if (typeof adminUserId !== "string" || adminUserId.length === 0) {
			return false;
		}

		return true;
	},

	handler: async (
		runtime: IAgentRuntime,
		message: Memory,
		_state?: State,
		options?: HandlerOptions,
		callback?: HandlerCallback,
	): Promise<ActionResult> => {
		const subaction = readEscalateSubaction(options);
		if (subaction === "admin") {
			return escalateToAdmin(runtime, message, options, callback);
		}
		return unsupportedEscalationTarget(subaction);
	},
};

function getAutonomyService(runtime: IAgentRuntime): AutonomyService | null {
	return (
		runtime.getService<AutonomyService>(AUTONOMY_SERVICE_TYPE) ??
		runtime.getService<AutonomyService>("autonomy") ??
		null
	);
}

function autonomyServiceUnavailable(actionName: string): ActionResult {
	return {
		success: false,
		text: "Autonomy service not available",
		error: "Autonomy service not available",
		data: {
			actionName,
			errorCode: "autonomy_service_unavailable",
		},
	};
}

function autonomyStatusData(
	service: AutonomyService,
): Record<string, JsonValue> {
	const status = service.getStatus();
	return {
		enabled: status.enabled,
		running: status.running,
		thinking: status.thinking,
		interval: status.interval,
		autonomousRoomId: status.autonomousRoomId,
	};
}

export const enableAutonomousModeAction: Action = {
	name: "ENABLE_AUTONOMOUS_MODE",
	similes: ["ENABLE_AUTONOMY", "START_AUTONOMY", "START_AUTONOMOUS_MODE"],
	contexts: ["admin", "messaging"],
	roleGate: { minRole: "ADMIN" },
	description:
		"Enable autonomous mode. OWNER and ADMIN may call this to start the continuous autonomy loop.",
	parameters: [],
	examples: [
		[
			{
				name: "User",
				content: {
					text: "Enable autonomous mode.",
					action: "ENABLE_AUTONOMOUS_MODE",
				},
			},
			{
				name: "Agent",
				content: {
					text: "Autonomous mode enabled.",
				},
			},
		],
	],
	validate: async (runtime: IAgentRuntime): Promise<boolean> => {
		return getAutonomyService(runtime) !== null;
	},
	handler: async (
		runtime: IAgentRuntime,
		_message: Memory,
		_state?: State,
		_options?: HandlerOptions,
		callback?: HandlerCallback,
	): Promise<ActionResult> => {
		const service = getAutonomyService(runtime);
		if (!service) {
			return autonomyServiceUnavailable("ENABLE_AUTONOMOUS_MODE");
		}

		await service.enableAutonomy();
		const text = "Autonomous mode enabled.";
		const data = {
			actionName: "ENABLE_AUTONOMOUS_MODE",
			...autonomyStatusData(service),
		};
		if (callback) {
			await callback({ text, data });
		}
		return { success: true, text, data };
	},
};

export const disableAutonomousModeAction: Action = {
	name: "DISABLE_AUTONOMOUS_MODE",
	similes: ["DISABLE_AUTONOMY", "STOP_AUTONOMY", "STOP_AUTONOMOUS_MODE"],
	contexts: ["admin", "messaging"],
	roleGate: { minRole: "ADMIN" },
	description:
		"Disable autonomous mode. OWNER and ADMIN may call this to stop the continuous autonomy loop.",
	parameters: [],
	examples: [
		[
			{
				name: "User",
				content: {
					text: "Disable autonomous mode.",
					action: "DISABLE_AUTONOMOUS_MODE",
				},
			},
			{
				name: "Agent",
				content: {
					text: "Autonomous mode disabled.",
				},
			},
		],
	],
	validate: async (runtime: IAgentRuntime): Promise<boolean> => {
		return getAutonomyService(runtime) !== null;
	},
	handler: async (
		runtime: IAgentRuntime,
		_message: Memory,
		_state?: State,
		_options?: HandlerOptions,
		callback?: HandlerCallback,
	): Promise<ActionResult> => {
		const service = getAutonomyService(runtime);
		if (!service) {
			return autonomyServiceUnavailable("DISABLE_AUTONOMOUS_MODE");
		}

		await service.disableAutonomy();
		const text = "Autonomous mode disabled.";
		const data = {
			actionName: "DISABLE_AUTONOMOUS_MODE",
			...autonomyStatusData(service),
		};
		if (callback) {
			await callback({ text, data });
		}
		return { success: true, text, data };
	},
};
