/**
 * Real owner/admin role gating for the APP action.
 *
 * Mirrors `hasOwnerAccess` / `hasAdminAccess` from
 * `@elizaos/agent/security/access`, but only depends on `@elizaos/core` so
 * this plugin doesn't have to take a dep on `@elizaos/agent` (which would
 * create a layer cycle).
 *
 * Behavior matches the canonical helper exactly:
 *   - missing runtime/message context → allow (auth is handled elsewhere)
 *   - sender is the agent itself → allow
 *   - sender is the canonical owner → allow
 *   - otherwise: check the sender role and require `isOwner` (for owner
 *     gate) or `isOwner || isAdmin` (for admin gate)
 *
 * Role-checker functions are injectable so tests can substitute fakes
 * without monkey-patching the `@elizaos/core` module.
 */

import {
	checkSenderRole as defaultCheckSenderRole,
	resolveCanonicalOwnerIdForMessage as defaultResolveCanonicalOwnerIdForMessage,
	type IAgentRuntime,
	type Memory,
} from "@elizaos/core";

type SenderRole = { isOwner?: boolean; isAdmin?: boolean } | null | undefined;

export type SecurityDeps = {
	checkSenderRole?: (
		runtime: IAgentRuntime,
		message: Memory,
	) => Promise<SenderRole>;
	resolveCanonicalOwnerIdForMessage?: (
		runtime: IAgentRuntime,
		message: Memory,
	) => Promise<string | null | undefined>;
};

type AccessContext = {
	runtime: IAgentRuntime & { agentId: string };
	message: Memory & { entityId: string };
};

function getAccessContext(
	runtime: IAgentRuntime | undefined,
	message: Memory | undefined,
): AccessContext | null {
	if (
		!runtime ||
		typeof runtime.agentId !== "string" ||
		!message ||
		typeof message.entityId !== "string" ||
		message.entityId.length === 0
	) {
		return null;
	}
	return { runtime, message } as AccessContext;
}

function isAgentSelf(context: AccessContext): boolean {
	return context.message.entityId === context.runtime.agentId;
}

async function isCanonicalOwner(
	context: AccessContext,
	resolveOwnerFn: NonNullable<
		SecurityDeps["resolveCanonicalOwnerIdForMessage"]
	>,
): Promise<boolean> {
	try {
		const ownerId = await resolveOwnerFn(context.runtime, context.message);
		return typeof ownerId === "string" && ownerId === context.message.entityId;
	} catch {
		return false;
	}
}

export async function hasOwnerAccess(
	runtime: IAgentRuntime | undefined,
	message: Memory | undefined,
	deps: SecurityDeps = {},
): Promise<boolean> {
	const context = getAccessContext(runtime, message);
	if (!context) return true;
	if (isAgentSelf(context)) return true;
	const resolveOwnerFn =
		deps.resolveCanonicalOwnerIdForMessage ??
		defaultResolveCanonicalOwnerIdForMessage;
	if (await isCanonicalOwner(context, resolveOwnerFn)) return true;
	const checkRoleFn = deps.checkSenderRole ?? defaultCheckSenderRole;
	try {
		const role = await checkRoleFn(context.runtime, context.message);
		return role?.isOwner === true;
	} catch {
		return false;
	}
}

export async function hasAdminAccess(
	runtime: IAgentRuntime | undefined,
	message: Memory | undefined,
	deps: SecurityDeps = {},
): Promise<boolean> {
	const context = getAccessContext(runtime, message);
	if (!context) return true;
	if (isAgentSelf(context)) return true;
	const resolveOwnerFn =
		deps.resolveCanonicalOwnerIdForMessage ??
		defaultResolveCanonicalOwnerIdForMessage;
	if (await isCanonicalOwner(context, resolveOwnerFn)) return true;
	const checkRoleFn = deps.checkSenderRole ?? defaultCheckSenderRole;
	try {
		const role = await checkRoleFn(context.runtime, context.message);
		return role?.isOwner === true || role?.isAdmin === true;
	} catch {
		return false;
	}
}
