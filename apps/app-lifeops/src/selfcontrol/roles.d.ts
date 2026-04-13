import type { IAgentRuntime, Memory } from "@elizaos/core";
type RoleName = "OWNER" | "ADMIN" | "USER" | "GUEST";
export type RoleCheckResult = {
    entityId: string;
    role: RoleName;
    isOwner: boolean;
    isAdmin: boolean;
    canManageRoles: boolean;
    hasPrivateAccess: boolean;
};
export declare function checkSenderRole(runtime: IAgentRuntime, message: Memory): Promise<RoleCheckResult | null>;
export {};
//# sourceMappingURL=roles.d.ts.map