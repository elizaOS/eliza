/**
 * Carries a host-admitted memory-read scope through asynchronous request work.
 * Supporting adapters intersect it with every caller-supplied read scope before
 * ranking or pagination. This is not a grant issuer, a write permission, or an
 * isolation boundary against plugin code with privileged raw storage access.
 */
import { ROLE_RANK, type RoleName } from "@elizaos/common";
import { getAmbientSingleton } from "./ambient-context";
import { ElizaError } from "./errors";
import type { AccessContext, IDatabaseAdapter, UUID } from "./types";
import { validateUuid } from "./utils";
import { AsyncContextManager } from "./utils/async-context-manager";

type RequiredContext = Readonly<
	AccessContext & { authorizedRoomIds: readonly UUID[] }
>;
type Binding = {
	readonly agentId: UUID;
	readonly context: RequiredContext;
	readonly authorize: () => Promise<void>;
	readonly parent?: Binding;
	active: boolean;
};
const key = Symbol.for("elizaos.requiredMemoryAccess.v1");
function storage(): AsyncContextManager<Binding> {
	return getAmbientSingleton(key, () => new AsyncContextManager<Binding>());
}
function rejected(code: string): ElizaError {
	return new ElizaError(
		"Required memory-read authority rejected the operation",
		{ code },
	);
}
function current(agentId: UUID): Binding | undefined {
	const binding = storage().active();
	if (!binding) return undefined;
	for (let scope: Binding | undefined = binding; scope; scope = scope.parent) {
		if (!scope.active) throw rejected("MEMORY_ACCESS_SCOPE_CLOSED");
		if (scope.agentId !== agentId)
			throw rejected("MEMORY_ACCESS_AGENT_MISMATCH");
	}
	return binding;
}
function role(context: AccessContext): RoleName | undefined {
	return context.isOwner ? "OWNER" : context.role;
}
function intersect(
	required: RequiredContext,
	requested?: AccessContext,
): RequiredContext {
	if (!requested) return required;
	if (requested.requesterEntityId !== required.requesterEntityId)
		throw rejected("MEMORY_ACCESS_ACTOR_MISMATCH");
	if (
		required.worldId !== undefined &&
		requested.worldId !== undefined &&
		required.worldId !== requested.worldId
	)
		throw rejected("MEMORY_ACCESS_WORLD_MISMATCH");
	const upperRole = role(required);
	const requestedRole = role(requested);
	const resolvedRole =
		upperRole === undefined || requestedRole === undefined
			? undefined
			: ROLE_RANK[upperRole] <= ROLE_RANK[requestedRole]
				? upperRole
				: requestedRole;
	const requestedRooms =
		requested.authorizedRoomIds === undefined
			? undefined
			: new Set(requested.authorizedRoomIds);
	return Object.freeze({
		requesterEntityId: required.requesterEntityId,
		worldId: required.worldId ?? requested.worldId,
		role: resolvedRole,
		isOwner: resolvedRole === "OWNER",
		source: required.source,
		authorizedRoomIds: Object.freeze(
			required.authorizedRoomIds.filter(
				(roomId) => !requestedRooms || requestedRooms.has(roomId),
			),
		),
	});
}

/**
 * Trusted hosts bind verified scope and a live authorization check. The callback
 * and its awaited children share it; detached work loses authority on completion.
 * Unsupported adapters fail before callback execution. Nested scopes only narrow.
 */
export async function withRequiredMemoryAccess<T>(
	runtime: {
		agentId: UUID;
		adapter: Pick<IDatabaseAdapter, "requiredMemoryAccessVersion">;
	},
	authority: {
		context: AccessContext & { authorizedRoomIds: readonly UUID[] };
		authorize: () => Promise<void>;
	},
	operation: () => Promise<T>,
): Promise<T> {
	if (runtime.adapter.requiredMemoryAccessVersion !== 1)
		throw rejected("MEMORY_ACCESS_ADAPTER_UNSUPPORTED");
	const input = authority.context;
	const inputRole = role(input);
	if (
		!validateUuid(runtime.agentId) ||
		!validateUuid(input.requesterEntityId) ||
		input.requesterEntityId === runtime.agentId ||
		!Array.isArray(input.authorizedRoomIds) ||
		input.authorizedRoomIds.some((id) => !validateUuid(id)) ||
		(input.worldId !== undefined && !validateUuid(input.worldId)) ||
		inputRole === undefined ||
		!Object.hasOwn(ROLE_RANK, inputRole)
	)
		throw rejected("MEMORY_ACCESS_SCOPE_INVALID");
	const parent = current(runtime.agentId);
	const snapshot = Object.freeze({
		...input,
		authorizedRoomIds: Object.freeze([...input.authorizedRoomIds]),
	});
	const binding: Binding = {
		agentId: runtime.agentId,
		context: parent ? intersect(parent.context, snapshot) : snapshot,
		authorize: authority.authorize,
		parent,
		active: true,
	};
	return storage().run(binding, async () => {
		try {
			await authorize(binding);
			return await operation();
		} finally {
			binding.active = false;
		}
	});
}

async function authorize(binding: Binding): Promise<void> {
	if (binding.parent) await authorize(binding.parent);
	current(binding.agentId);
	try {
		await binding.authorize();
	} catch (cause) {
		// error-policy:J2 A failed authority check permanently closes this request scope.
		binding.active = false;
		throw new ElizaError(
			"Required memory-read authority is unavailable or revoked",
			{
				code: "MEMORY_ACCESS_AUTHORITY_REJECTED",
				cause,
			},
		);
	}
	current(binding.agentId);
}

/** Caches with no scope identity must bypass their shared entries in this mode. */
export function hasRequiredMemoryAccess(agentId: UUID): boolean {
	return current(agentId) !== undefined;
}

/** Called by supporting adapters before any protected memory query work. */
export async function resolveRequiredMemoryAccess(
	agentId: UUID,
	requested?: AccessContext,
): Promise<AccessContext | undefined> {
	const binding = current(agentId);
	if (!binding) return requested;
	await authorize(binding);
	return intersect(binding.context, requested);
}
