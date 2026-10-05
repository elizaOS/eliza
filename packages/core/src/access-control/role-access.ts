/** Role gates shared by runtime dispatch and optional plugins. */
import { hasRoleAccess, type RoleAccessDeps } from "../roles.ts";
import type { Memory } from "../types/memory.ts";
import type { IAgentRuntime } from "../types/runtime.ts";

export type SecurityDeps = RoleAccessDeps;

export function hasOwnerAccess(
	runtime: IAgentRuntime | undefined,
	message: Memory | undefined,
	deps: SecurityDeps = {},
): Promise<boolean> {
	return hasRoleAccess(runtime, message, "OWNER", deps);
}

export function hasAdminAccess(
	runtime: IAgentRuntime | undefined,
	message: Memory | undefined,
	deps: SecurityDeps = {},
): Promise<boolean> {
	return hasRoleAccess(runtime, message, "ADMIN", deps);
}
