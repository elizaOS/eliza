/**
 * Owner/admin role gating for the PLUGIN action.
 *
 * Lives in core so other plugins (and the built-in pluginManagerCapability) can
 * import it without taking a dep on `@elizaos/agent` (which would create a layer
 * cycle — `@elizaos/agent` already depends on this capability).
 *
 * #12087 Item 18: these are thin wrappers over the ONE role-resolution flow,
 * roles.ts `hasRoleAccess` (missing context → allow; agent-self → allow;
 * canonical owner → allow; otherwise checkSenderRole → rank compare). The
 * previous copies had their own getAccessContext / isAgentSelf / isCanonicalOwner
 * and had already drifted from roles.ts. Role-checker functions stay injectable
 * (via `hasRoleAccess`'s deps) so tests can substitute fakes without
 * monkey-patching the module (bun's `mock.module` persists across test files in
 * the same run, which would contaminate unrelated suites).
 */

import { hasRoleAccess, type RoleAccessDeps } from "../../roles.ts";
import type { Memory } from "../../types/memory.ts";
import type { IAgentRuntime } from "../../types/runtime.ts";

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
