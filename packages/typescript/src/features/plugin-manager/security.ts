/**
 * Real owner/admin role gating for the PLUGIN action.
 *
 * Lives in core so other plugins (and the built-in pluginManagerCapability)
 * can import it without taking a dep on `@elizaos/agent` (which would
 * create a layer cycle — `@elizaos/agent` already depends on this
 * capability).
 *
 * Behavior:
 *   - missing runtime/message context → allow (auth is handled elsewhere)
 *   - sender is the agent itself → allow
 *   - sender is the canonical owner → allow
 *   - otherwise: check the sender role via `checkSenderRole` and require
 *     `isOwner` (for owner gate) or `isOwner || isAdmin` (for admin gate)
 *
 * Role-checker functions are injectable so tests can substitute fakes
 * without monkey-patching the module (bun's `mock.module` persists across
 * test files in the same run, which would contaminate unrelated suites).
 */

import {
	checkSenderRole as defaultCheckSenderRole,
	resolveCanonicalOwnerIdForMessage as defaultResolveCanonicalOwnerIdForMessage,
} from "../../roles.ts";
import type { Memory } from "../../types/memory.ts";
import type { IAgentRuntime } from "../../types/runtime.ts";

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
