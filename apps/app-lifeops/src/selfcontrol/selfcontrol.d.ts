import type { HandlerOptions, Memory } from "@elizaos/core";
import type { PermissionState } from "./permissions.js";
export type SelfControlElevationMethod = "osascript" | "pkexec" | "powershell-runas";
export interface SelfControlPluginConfig {
    hostsFilePath?: string;
    statusCacheTtlMs?: number;
}
export interface SelfControlStatus {
    available: boolean;
    active: boolean;
    hostsFilePath: string | null;
    startedAt: string | null;
    endsAt: string | null;
    websites: string[];
    managedBy: string | null;
    metadata: Record<string, unknown> | null;
    scheduledByAgentId: string | null;
    canUnblockEarly: boolean;
    requiresElevation: boolean;
    engine: "hosts-file";
    platform: NodeJS.Platform;
    supportsElevationPrompt: boolean;
    elevationPromptMethod: SelfControlElevationMethod | null;
    reason?: string;
}
export interface SelfControlPermissionState extends PermissionState {
    id: "website-blocking";
    hostsFilePath?: string | null;
    supportsElevationPrompt?: boolean;
    elevationPromptMethod?: SelfControlElevationMethod | null;
    promptAttempted?: boolean;
    promptSucceeded?: boolean;
}
export interface SelfControlBlockRequest {
    websites: string[];
    durationMinutes: number | null;
    metadata?: Record<string, unknown> | null;
    scheduledByAgentId?: string | null;
}
export interface SelfControlBlockMetadata {
    version: 1;
    startedAt: string;
    endsAt: string | null;
    websites: string[];
    managedBy: string | null;
    metadata: Record<string, unknown> | null;
    scheduledByAgentId?: string | null;
}
type PrivilegedHostsWriteInvocation = {
    command: string;
    args: string[];
    workerScriptContent?: string;
};
export declare function setSelfControlPluginConfig(nextConfig: SelfControlPluginConfig | undefined): void;
export declare function getSelfControlPluginConfig(): SelfControlPluginConfig;
export declare function resetSelfControlStatusCache(): void;
export declare function cancelSelfControlExpiryTimer(): void;
export declare function resolveSelfControlHostsFilePath(config?: SelfControlPluginConfig): Promise<string | null>;
export declare function reconcileSelfControlBlockState(config?: SelfControlPluginConfig): Promise<SelfControlStatus>;
export declare function getSelfControlStatus(config?: SelfControlPluginConfig): Promise<SelfControlStatus>;
export declare function getCachedSelfControlStatus(config?: SelfControlPluginConfig): Promise<SelfControlStatus>;
export declare function getSelfControlPermissionState(config?: SelfControlPluginConfig): Promise<SelfControlPermissionState>;
export declare function requestSelfControlPermission(config?: SelfControlPluginConfig): Promise<SelfControlPermissionState>;
export declare function openSelfControlPermissionLocation(config?: SelfControlPluginConfig): Promise<boolean>;
export declare function startSelfControlBlock(request: SelfControlBlockRequest, config?: SelfControlPluginConfig): Promise<{
    success: true;
    endsAt: string | null;
} | {
    success: false;
    error: string;
    status?: SelfControlStatus;
}>;
export declare function stopSelfControlBlock(config?: SelfControlPluginConfig): Promise<{
    success: true;
    removed: boolean;
    status: SelfControlStatus;
} | {
    success: false;
    error: string;
    status?: SelfControlStatus;
}>;
export declare function buildSelfControlManagedHostsBlock(metadata: SelfControlBlockMetadata, lineEnding?: string): string;
export declare function parseSelfControlBlockRequest(options?: HandlerOptions, message?: Memory): {
    request: SelfControlBlockRequest | null;
    error?: string;
};
export declare function normalizeWebsiteTargets(rawTargets: readonly string[]): string[];
export declare function formatWebsiteList(websites: readonly string[]): string;
export declare function resolveSelfControlElevationPromptMethod(platform?: NodeJS.Platform): SelfControlElevationMethod | null;
export declare function buildPrivilegedHostsWriteInvocation(sourcePath: string, targetPath: string, platform?: NodeJS.Platform, workerScriptPath?: string): PrivilegedHostsWriteInvocation | null;
export declare function extractDurationMinutesFromText(text: string): number | null;
export declare function hasIndefiniteBlockIntent(text: string): boolean;
export declare function hasWebsiteBlockDeferralIntent(text: string): boolean;
export declare function hasWebsiteBlockIntent(text: string): boolean;
export declare function extractWebsiteTargetsFromText(text: string): string[];
export {};
//# sourceMappingURL=selfcontrol.d.ts.map