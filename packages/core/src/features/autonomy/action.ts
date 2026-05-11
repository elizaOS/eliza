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
	UUID,
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

function notYetImplemented(subaction: EscalateSubaction): ActionResult {
	const text = `ESCALATE action=${subaction} not yet implemented`;
	return {
		success: false,
		text,
		error: text,
		data: {
			actionName: "ESCALATE",
			[CANONICAL_SUBACTION_KEY]: subaction,
			errorCode: "not_implemented",
		},
	};
}

async function escalateToAdmin(
	runtime: IAgentRuntime,
	message: Memory,
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

	const autonomousRoomId = autonomyService.getAutonomousRoomId?.();
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

	// Find target room
	const adminMessages = await runtime.getMemories({
		roomId: runtime.agentId,
		limit: 10,
		tableName: "memories",
	});

	let targetRoomId: UUID;
	if (adminMessages && adminMessages.length > 0) {
		const lastMessage = adminMessages[adminMessages.length - 1];
		targetRoomId = lastMessage.roomId ?? runtime.agentId;
	} else {
		targetRoomId = runtime.agentId;
	}

	// Extract message content
	const autonomousThought = message.content.text || "";

	// Generate message to admin
	let messageToAdmin: string;
	if (
		autonomousThought.includes("completed") ||
		autonomousThought.includes("finished")
	) {
		messageToAdmin = `I've completed a task and wanted to update you. My thoughts: ${autonomousThought}`;
	} else if (
		autonomousThought.includes("problem") ||
		autonomousThought.includes("issue") ||
		autonomousThought.includes("error")
	) {
		messageToAdmin = `I encountered something that might need your attention: ${autonomousThought}`;
	} else if (
		autonomousThought.includes("question") ||
		autonomousThought.includes("unsure")
	) {
		messageToAdmin = `I have a question and would appreciate your guidance: ${autonomousThought}`;
	} else {
		messageToAdmin = `Autonomous update: ${autonomousThought}`;
	}

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
 * Allows an autonomous agent to escalate a message to a human. The `admin`
 * action surfaces the message to the configured admin user; `owner` and
 * `third_party` are reserved for future escalation routes (account owner,
 * external paged human) and currently return a "not yet implemented" result.
 */
export const escalateAction: Action = {
	name: "ESCALATE",
	contexts: ["admin", "messaging", "agent_internal"],
	roleGate: { minRole: "ADMIN" },
	description:
		"Escalate from autonomous context to a human. action=admin sends to the configured admin; owner/third_party are placeholders.",
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

		const autonomousRoomId = autonomyService.getAutonomousRoomId?.();
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
			return escalateToAdmin(runtime, message, callback);
		}
		return notYetImplemented(subaction);
	},
};

// Back-compat alias for the previous canonical export name. Code that already
// imports `sendToAdminAction` keeps working; new code should import
// `escalateAction`.
export const sendToAdminAction = escalateAction;
