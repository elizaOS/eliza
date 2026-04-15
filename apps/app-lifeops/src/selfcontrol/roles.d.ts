import type { IAgentRuntime, Memory, RoleCheckResult as CoreRoleCheckResult } from "@elizaos/core";
export type RoleCheckResult = CoreRoleCheckResult & {
    hasPrivateAccess: boolean;
};
export declare function checkSenderRole(runtime: IAgentRuntime, message: Memory): Promise<RoleCheckResult | null>;
