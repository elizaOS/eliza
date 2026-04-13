import type { IAgentRuntime, Memory } from "@elizaos/core";
export declare const SELFCONTROL_ACCESS_ERROR = "Website blocking is restricted to OWNER and ADMIN users.";
export declare function getSelfControlAccess(runtime: IAgentRuntime, message: Memory): Promise<{
    allowed: boolean;
    role: string | null;
    reason?: string;
}>;
//# sourceMappingURL=access.d.ts.map