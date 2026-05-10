/**
 * ROLE — polymorphic role-management action.
 *
 * Operations:
 *   - assign: structured `assignments[]` (entityId + newRole) OR single `target` name
 *             with recent-room disambiguation. Hierarchy validation per-assignment.
 *   - revoke: single or batch revoke (sets target(s) to GUEST). Hierarchy-checked.
 *   - list:   returns current role assignments for the world.
 */

import {
	findKeywordTermMatch,
	getValidationKeywordTerms,
} from "../../../i18n/validation-keywords.ts";
import { logger } from "../../../logger.ts";
import {
	canModifyRole,
	getLiveEntityMetadataFromMessage,
	normalizeRole,
	type RoleName,
	resolveCanonicalOwnerId,
	resolveEntityRole,
	resolveWorldForMessage,
	setEntityRole,
} from "../../../roles.ts";
import type {
	Action,
	ActionResult,
	HandlerCallback,
	HandlerOptions,
	IAgentRuntime,
	Memory,
	State,
	UUID,
} from "../../../types/index.ts";
import { ChannelType } from "../../../types/index.ts";
import { asRecord } from "../../../utils/type-guards.ts";

const ROLE_OPS = ["assign", "revoke", "list"] as const;
type RoleOp = (typeof ROLE_OPS)[number];

const ROLE_NAMES: readonly RoleName[] = ["OWNER", "ADMIN", "USER", "GUEST"];

const MAX_USERNAME_LENGTH = 64;
const RECENT_ROOM_MESSAGE_LIMIT = 100;
const AMBIGUOUS_MATCH_SCORE_GAP = 10;
const MIN_CONFIDENT_MATCH_SCORE = 70;

const ROLE_TARGET_PRONOUNS = new Set([
	"he",
	"him",
	"his",
	"she",
	"her",
	"hers",
	"they",
	"them",
	"their",
	"theirs",
]);

const ROLE_INTENT_KEYWORDS = getValidationKeywordTerms(
	"action.updateRole.intent",
	{ includeAllLocales: true },
);

const NATURAL_ROLE_MAP: Record<string, RoleName> = {
	boss: "ADMIN",
	manager: "ADMIN",
	supervisor: "ADMIN",
	superior: "ADMIN",
	lead: "ADMIN",
	mod: "ADMIN",
	moderator: "ADMIN",
	coworker: "USER",
	"co-worker": "USER",
	teammate: "USER",
	colleague: "USER",
	peer: "USER",
	friend: "USER",
	partner: "USER",
	member: "USER",
	user: "USER",
};

interface AssignmentJson {
	entityId?: string;
	newRole?: string;
}

interface RoleAssignment {
	entityId: UUID;
	newRole: RoleName;
}

interface CandidateRecord {
	entityId: UUID;
	names: string[];
	aliases: string[];
	inCurrentRoom: boolean;
	spokeRecentlyInRoom: boolean;
	lastRoomActivityAt?: number;
}

interface RoleHandlerParams {
	op?: string;
	target?: string;
	role?: string;
	label?: string;
	assignments?: unknown;
}

function readParams(
	message: Memory,
	options?: HandlerOptions,
): RoleHandlerParams {
	const params = asRecord(options?.parameters) ?? {};
	const messageContent = asRecord(message.content) ?? {};
	return {
		op:
			typeof params.op === "string"
				? params.op
				: typeof params.mode === "string"
					? params.mode
					: undefined,
		target:
			typeof params.target === "string"
				? params.target
				: typeof params.user === "string"
					? params.user
					: undefined,
		role: typeof params.role === "string" ? params.role : undefined,
		label: typeof params.label === "string" ? params.label : undefined,
		assignments: params.assignments ?? messageContent.assignments,
	};
}

function normalizeOp(raw: string | undefined): RoleOp | null {
	if (!raw) return null;
	const v = raw.trim().toLowerCase();
	if (v === "assign" || v === "set" || v === "update" || v === "promote") {
		return "assign";
	}
	if (
		v === "revoke" ||
		v === "remove" ||
		v === "delete" ||
		v === "unset" ||
		v === "demote"
	) {
		return "revoke";
	}
	if (v === "list" || v === "get") {
		return "list";
	}
	return null;
}

function normalizeRoleInput(raw: string): RoleName | null {
	const upper = raw.trim().toUpperCase();
	if (!upper) return null;
	if (upper === "MEMBER" || upper === "NONE") return "GUEST";
	if (upper === "MOD" || upper === "MODERATOR") return "ADMIN";
	if ((ROLE_NAMES as readonly string[]).includes(upper)) {
		return upper as RoleName;
	}
	return NATURAL_ROLE_MAP[raw.trim().toLowerCase()] ?? null;
}

function normalizeAssignmentArray(raw: unknown): AssignmentJson[] {
	if (!Array.isArray(raw)) return [];
	const out: AssignmentJson[] = [];
	for (const entry of raw) {
		const rec = asRecord(entry);
		if (!rec) continue;
		const entityId =
			typeof rec.entityId === "string" ? rec.entityId : undefined;
		const newRole = typeof rec.newRole === "string" ? rec.newRole : undefined;
		if (entityId || newRole) {
			out.push({ entityId, newRole });
		}
	}
	return out;
}

function normalizeEntityLookupName(raw: string): string | null {
	const safeRaw = raw.length > 1024 ? raw.slice(0, 1024) : raw;
	const normalized = safeRaw
		.trim()
		.replace(/^@{1,1024}/, "")
		.replace(/[.!?,;:]{1,1024}$/g, "")
		.trim();
	if (!normalized || normalized.length > MAX_USERNAME_LENGTH) {
		return null;
	}
	return normalized;
}

function isPronoun(raw: string): boolean {
	return ROLE_TARGET_PRONOUNS.has(raw.trim().replace(/^@+/, "").toLowerCase());
}

export function looksLikeRoleIntent(text: string): boolean {
	const trimmed = text.trim();
	if (!trimmed) return false;
	return findKeywordTermMatch(trimmed, ROLE_INTENT_KEYWORDS) !== undefined;
}

function collectCandidateNames(args: {
	names?: string[];
	metadata?: Record<string, unknown>;
}): { names: string[]; aliases: string[] } {
	const names = new Set<string>();
	const aliases = new Set<string>();
	for (const n of args.names ?? []) {
		if (typeof n === "string" && n.trim().length > 0) names.add(n.trim());
	}
	const metadata = asRecord(args.metadata);
	if (metadata) {
		for (const source of Object.values(metadata)) {
			const sourceRecord = asRecord(source);
			if (!sourceRecord) continue;
			for (const key of [
				"username",
				"userName",
				"name",
				"displayName",
				"handle",
				"screenName",
			]) {
				const value = sourceRecord[key];
				if (typeof value === "string" && value.trim().length > 0) {
					aliases.add(value.trim());
				}
			}
		}
	}
	return { names: [...names], aliases: [...aliases] };
}

function normalizeComparisonValue(value: string): string {
	return value.trim().replace(/^@+/, "").replace(/\s+/g, " ").toLowerCase();
}

function scoreNameMatch(target: string, candidate: CandidateRecord): number {
	const t = normalizeComparisonValue(target);
	let best = 0;
	for (const raw of [...candidate.names, ...candidate.aliases]) {
		const v = normalizeComparisonValue(raw);
		if (!v) continue;
		let score = 0;
		if (v === t) score = 100;
		else if (v.split(/\s+/).includes(t)) score = 88;
		else if (v.startsWith(t) || t.startsWith(v)) score = 80;
		else if (v.includes(t) || t.includes(v)) score = 68;
		if (score > best) best = score;
	}
	return best;
}

async function getRecentRoomActivity(
	runtime: IAgentRuntime,
	roomId: UUID,
): Promise<Map<UUID, number>> {
	const activity = new Map<UUID, number>();
	if (typeof runtime.getMemoriesByRoomIds !== "function") return activity;
	const memories = await runtime.getMemoriesByRoomIds({
		tableName: "messages",
		roomIds: [roomId],
		limit: RECENT_ROOM_MESSAGE_LIMIT,
	});
	for (const memory of memories) {
		if (!memory?.entityId || typeof memory.createdAt !== "number") continue;
		const id = memory.entityId as UUID;
		const previous = activity.get(id) ?? 0;
		if (memory.createdAt > previous) activity.set(id, memory.createdAt);
	}
	return activity;
}

async function resolveTargetEntityIdByName(args: {
	runtime: IAgentRuntime;
	roomId: UUID;
	targetName: string;
}): Promise<{ entityId: UUID | null; error?: string }> {
	const { runtime, roomId, targetName } = args;
	const candidates = new Map<UUID, CandidateRecord>();
	const recentActivity = await getRecentRoomActivity(runtime, roomId);

	const roomEntities = await runtime.getEntitiesForRoom(roomId);
	for (const entity of roomEntities) {
		if (!entity?.id) continue;
		const id = entity.id as UUID;
		const ids = collectCandidateNames({
			names: entity.names as string[] | undefined,
			metadata: entity.metadata as Record<string, unknown> | undefined,
		});
		candidates.set(id, {
			entityId: id,
			names: ids.names,
			aliases: ids.aliases,
			inCurrentRoom: true,
			spokeRecentlyInRoom: recentActivity.has(id),
			lastRoomActivityAt: recentActivity.get(id),
		});
	}

	for (const id of recentActivity.keys()) {
		if (candidates.has(id)) continue;
		if (typeof runtime.getEntityById !== "function") continue;
		const entity = await runtime.getEntityById(id);
		if (!entity) continue;
		const ids = collectCandidateNames({
			names: entity.names as string[] | undefined,
			metadata: entity.metadata as Record<string, unknown> | undefined,
		});
		candidates.set(id, {
			entityId: id,
			names: ids.names,
			aliases: ids.aliases,
			inCurrentRoom: false,
			spokeRecentlyInRoom: true,
			lastRoomActivityAt: recentActivity.get(id),
		});
	}

	const ranked = [...candidates.values()]
		.map((candidate) => {
			const nameScore = scoreNameMatch(targetName, candidate);
			if (nameScore === 0) return null;
			let score = nameScore;
			if (candidate.inCurrentRoom) score += 14;
			if (candidate.spokeRecentlyInRoom) score += 12;
			return { candidate, score };
		})
		.filter((entry): entry is NonNullable<typeof entry> => entry !== null)
		.sort((a, b) => b.score - a.score);

	if (ranked.length === 0) {
		return {
			entityId: null,
			error: `Could not find user "${targetName}" in this room.`,
		};
	}

	const [best, second] = ranked;
	if (
		best.score < MIN_CONFIDENT_MATCH_SCORE ||
		(second && best.score - second.score < AMBIGUOUS_MATCH_SCORE_GAP)
	) {
		return {
			entityId: null,
			error: `Multiple possible matches for "${targetName}". Use a more specific name.`,
		};
	}

	return { entityId: best.candidate.entityId };
}

async function buildAssignmentsFromParams(args: {
	runtime: IAgentRuntime;
	message: Memory;
	params: RoleHandlerParams;
	defaultRole: RoleName | null;
}): Promise<{ assignments: RoleAssignment[]; errors: string[] }> {
	const { runtime, message, params, defaultRole } = args;
	const errors: string[] = [];
	const assignments: RoleAssignment[] = [];

	const structured = normalizeAssignmentArray(params.assignments);
	for (const entry of structured) {
		if (!entry.entityId) {
			errors.push("Assignment missing entityId");
			continue;
		}
		const newRole = entry.newRole
			? normalizeRoleInput(entry.newRole)
			: defaultRole;
		if (!newRole) {
			errors.push(`Invalid role for ${entry.entityId}`);
			continue;
		}
		assignments.push({ entityId: entry.entityId as UUID, newRole });
	}

	if (assignments.length === 0 && params.target) {
		const targetName = normalizeEntityLookupName(params.target);
		if (!targetName || isPronoun(params.target)) {
			errors.push("Could not determine target user.");
			return { assignments, errors };
		}
		const newRole = params.role
			? normalizeRoleInput(params.role)
			: params.label
				? (NATURAL_ROLE_MAP[params.label.trim().toLowerCase()] ?? null)
				: defaultRole;
		if (!newRole) {
			errors.push("Could not determine target role.");
			return { assignments, errors };
		}
		const resolution = await resolveTargetEntityIdByName({
			runtime,
			roomId: message.roomId,
			targetName,
		});
		if (!resolution.entityId) {
			errors.push(resolution.error ?? `User "${targetName}" not found.`);
			return { assignments, errors };
		}
		assignments.push({ entityId: resolution.entityId, newRole });
	}

	return { assignments, errors };
}

async function applyAssignments(args: {
	runtime: IAgentRuntime;
	message: Memory;
	assignments: RoleAssignment[];
	op: "assign" | "revoke";
	callback?: HandlerCallback;
}): Promise<ActionResult> {
	const { runtime, message, assignments, op, callback } = args;

	const resolved = await resolveWorldForMessage(runtime, message);
	if (!resolved) {
		await callback?.({
			text: "Cannot manage roles — no world context for this room.",
		});
		return {
			success: false,
			text: "World not found",
			error: "WORLD_NOT_FOUND",
			data: { actionName: "ROLE", op },
		};
	}

	const { world, metadata } = resolved;
	if (!world) {
		await callback?.({
			text: "Cannot manage roles — no world context for this room.",
		});
		return {
			success: false,
			text: "World not found",
			error: "WORLD_NOT_FOUND",
			data: { actionName: "ROLE", op },
		};
	}
	const requesterRole = await resolveEntityRole(
		runtime,
		world,
		metadata,
		message.entityId,
		{ liveEntityMetadata: getLiveEntityMetadataFromMessage(message) },
	);

	if (requesterRole !== "OWNER" && requesterRole !== "ADMIN") {
		await callback?.({
			text: "Only OWNERs and ADMINs can manage roles.",
		});
		return {
			success: false,
			text: "Insufficient permissions",
			error: "INSUFFICIENT_PERMISSIONS",
			data: { actionName: "ROLE", op, requesterRole },
		};
	}

	const successes: Array<{ entityId: UUID; newRole: RoleName }> = [];
	const failures: Array<{ entityId: UUID; reason: string }> = [];

	for (const { entityId, newRole } of assignments) {
		if (entityId === runtime.agentId) {
			failures.push({ entityId, reason: "Cannot change agent's own role" });
			continue;
		}

		const currentRole = await resolveEntityRole(
			runtime,
			world,
			metadata,
			entityId,
		);

		if (newRole === "OWNER") {
			const canonicalOwnerId = resolveCanonicalOwnerId(runtime, metadata);
			if (!canonicalOwnerId || entityId !== canonicalOwnerId) {
				failures.push({
					entityId,
					reason: "OWNER reserved for canonical owner",
				});
				continue;
			}
		}

		if (
			entityId === message.entityId &&
			requesterRole === "OWNER" &&
			newRole !== "OWNER"
		) {
			const otherOwners = Object.entries(metadata.roles ?? {}).filter(
				([id, r]) => id !== message.entityId && normalizeRole(r) === "OWNER",
			);
			if (otherOwners.length === 0) {
				failures.push({
					entityId,
					reason: "Cannot remove the last OWNER",
				});
				continue;
			}
		}

		if (!canModifyRole(requesterRole, currentRole, newRole)) {
			failures.push({
				entityId,
				reason: `Cannot change ${currentRole} → ${newRole} as ${requesterRole}`,
			});
			continue;
		}

		await setEntityRole(runtime, message, entityId, newRole);
		successes.push({ entityId, newRole });
		logger.info(
			{
				src: "advanced-capabilities:action:role",
				agentId: runtime.agentId,
				op,
				entityId,
				newRole,
			},
			`[role] ${message.entityId} ${op === "revoke" ? "revoked" : "set"} ${entityId} to ${newRole}`,
		);
	}

	const summary =
		op === "revoke"
			? `Revoked ${successes.length} role(s)`
			: `Updated ${successes.length} role(s)`;

	await callback?.({
		text:
			failures.length > 0 ? `${summary}; ${failures.length} failed.` : summary,
		actions: ["ROLE"],
	});

	return {
		success: successes.length > 0,
		text: summary,
		values: {
			successCount: successes.length,
			failureCount: failures.length,
		},
		data: {
			actionName: "ROLE",
			op,
			successCount: successes.length,
			failureCount: failures.length,
			worldId: world.id ?? "",
		},
	};
}

async function handleList(args: {
	runtime: IAgentRuntime;
	message: Memory;
	callback?: HandlerCallback;
}): Promise<ActionResult> {
	const { runtime, message, callback } = args;
	const resolved = await resolveWorldForMessage(runtime, message);
	if (!resolved) {
		await callback?.({ text: "No world context found." });
		return {
			success: false,
			text: "World not found",
			error: "WORLD_NOT_FOUND",
			data: { actionName: "ROLE", op: "list" },
		};
	}
	const roles = resolved.metadata.roles ?? {};
	const entries = Object.entries(roles);
	const text =
		entries.length === 0
			? "No role assignments."
			: entries.map(([entityId, role]) => `${entityId}: ${role}`).join("\n");
	await callback?.({ text, actions: ["ROLE"] });
	return {
		success: true,
		text,
		values: { roleCount: entries.length },
		data: {
			actionName: "ROLE",
			op: "list",
			roles: roles as Record<string, RoleName>,
		},
	};
}

export const roleAction: Action = {
	name: "ROLE",
	contexts: ["admin", "settings"],
	roleGate: { minRole: "OWNER" },
	suppressPostActionContinuation: true,
	description:
		"Manage roles (OWNER/ADMIN/USER/GUEST) in a world. Operations: assign, revoke, list. " +
		"Accepts structured assignments[] or single target name with recent-room disambiguation.",
	parameters: [
		{
			name: "subaction",
			description: "Operation to perform: assign, revoke, or list.",
			required: false,
			schema: {
				type: "string" as const,
				enum: [...ROLE_OPS],
				default: "assign",
			},
		},
		{
			name: "target",
			description:
				"Single target by name when assignments[] is not supplied. Resolved against the current room.",
			required: false,
			schema: { type: "string" as const },
		},
		{
			name: "role",
			description: "Role to assign when using single-target form.",
			required: false,
			schema: {
				type: "string" as const,
				enum: [...ROLE_NAMES],
			},
		},
		{
			name: "label",
			description:
				"Optional natural-language label (boss, coworker, etc.) used to derive role.",
			required: false,
			schema: { type: "string" as const },
		},
		{
			name: "assignments",
			description: "Batch assignments by entityId. Used by assign/revoke.",
			required: false,
			schema: {
				type: "array" as const,
				items: {
					type: "object" as const,
					properties: {
						entityId: { type: "string" as const },
						newRole: {
							type: "string" as const,
							enum: [...ROLE_NAMES],
						},
					},
					required: ["entityId"],
				},
			},
		},
	],

	validate: async (
		runtime: IAgentRuntime,
		message: Memory,
		state?: State,
		options?: HandlerOptions,
	): Promise<boolean> => {
		const channelType = message.content.channelType as ChannelType;
		if (
			channelType !== ChannelType.GROUP &&
			channelType !== ChannelType.WORLD
		) {
			return false;
		}
		const room = state?.data?.room ?? (await runtime.getRoom(message.roomId));
		if (!room?.messageServerId) return false;

		const params = readParams(message, options);
		if (params.op || params.assignments || params.target) return true;

		return true;
	},

	handler: async (
		runtime: IAgentRuntime,
		message: Memory,
		_state?: State,
		options?: HandlerOptions,
		callback?: HandlerCallback,
	): Promise<ActionResult> => {
		const params = readParams(message, options);
		const op = normalizeOp(params.op) ?? "assign";

		if (!(ROLE_OPS as readonly string[]).includes(op)) {
			await callback?.({ text: `Unknown ROLE op: ${params.op}` });
			return {
				success: false,
				text: "Invalid op",
				error: "ROLE_INVALID",
				data: { actionName: "ROLE", op: params.op ?? null },
			};
		}

		if (op === "list") {
			return handleList({ runtime, message, callback });
		}

		const defaultRole: RoleName | null = op === "revoke" ? "GUEST" : null;
		const { assignments, errors } = await buildAssignmentsFromParams({
			runtime,
			message,
			params,
			defaultRole,
		});

		if (assignments.length === 0) {
			const reason =
				errors[0] ?? "No valid role assignments derived from the request.";
			await callback?.({ text: reason });
			return {
				success: false,
				text: reason,
				error: op === "revoke" ? "ROLE_REVOKE_FAILED" : "ROLE_ASSIGN_FAILED",
				data: { actionName: "ROLE", op, errors },
			};
		}

		return applyAssignments({
			runtime,
			message,
			assignments,
			op,
			callback,
		});
	},
	similes: [
		"UPDATE_ROLE",
		"ASSIGN_ROLE",
		"SET_ROLE",
		"REVOKE_ROLE",
		"LIST_ROLES",
		"PROMOTE_USER",
		"DEMOTE_USER",
		"MANAGE_PERMISSIONS",
	],
	examples: [
		[
			{
				name: "{{name1}}",
				content: { text: "Make Pat an admin in this world.", source: "chat" },
			},
			{
				name: "{{agentName}}",
				content: {
					text: "Updated 1 role(s)",
					actions: ["ROLE"],
					thought:
						"Single-target promote intent maps to ROLE subaction=assign with target='Pat' and role='ADMIN'.",
				},
			},
		],
		[
			{
				name: "{{name1}}",
				content: {
					text: "Show me everyone's role in this server.",
					source: "chat",
				},
			},
			{
				name: "{{agentName}}",
				content: {
					text: "Listing role assignments.",
					actions: ["ROLE"],
					thought:
						"Inventory query maps to ROLE subaction=list which returns all entityId->role pairs for the world.",
				},
			},
		],
		[
			{
				name: "{{name1}}",
				content: { text: "Revoke admin from Pat.", source: "chat" },
			},
			{
				name: "{{agentName}}",
				content: {
					text: "Revoked 1 role(s)",
					actions: ["ROLE"],
					thought:
						"Revoke intent maps to ROLE subaction=revoke; defaultRole becomes GUEST so Pat drops to GUEST.",
				},
			},
		],
	],
};

// Backwards-compatible export name for the existing barrel re-export.
export const updateRoleAction = roleAction;
