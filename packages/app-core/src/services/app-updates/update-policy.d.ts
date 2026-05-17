import type { AgentUpdateAuthority, AgentUpdateStatus } from "@elizaos/shared";
import { type BuildVariant } from "@elizaos/ui/build-variant";
export type AppUpdatePlatform = "desktop" | "ios" | "android" | "web";
export type AppDistributionChannel = "desktop-direct" | "desktop-store" | "ios-app-store" | "ios-sideload" | "android-google-play" | "android-sideload" | "android-aosp" | "web";
export type AppUpdateAuthority = "github" | "store" | "aosp-image" | "web";
export interface NativeAppInfo {
    name?: string;
    id?: string;
    version?: string;
    build?: string;
}
export interface AppUpdatePolicyInput {
    platform: AppUpdatePlatform;
    native: boolean;
    buildVariant: BuildVariant;
    elizaOS: boolean;
}
export interface AppUpdatePolicy {
    channel: AppDistributionChannel;
    authority: AppUpdateAuthority;
    canAutoUpdate: boolean;
    canManualCheck: boolean;
    canOpenReleaseNotes: boolean;
    statusLabel: string;
    detail: string;
    actionLabel: string | null;
}
export interface ApplicationUpdateSnapshot extends AppUpdatePolicy {
    appName: string;
    appId: string | null;
    version: string;
    build: string | null;
    platform: AppUpdatePlatform;
    buildVariant: BuildVariant;
}
export type AgentUpdateUiStatus = "current" | "update-available" | "error";
export interface ConnectedAgentUpdateSnapshot {
    authority: AgentUpdateAuthority;
    authorityLabel: string;
    installMethod: string;
    currentVersion: string;
    latestVersion: string | null;
    channel: AgentUpdateStatus["channel"];
    updateAvailable: boolean;
    lastCheckAt: string | null;
    error: string | null;
    status: AgentUpdateUiStatus;
    statusLabel: string;
    detail: string;
    canManualCheck: boolean;
    canAutoUpdate: boolean;
    actionLabel: string | null;
}
export declare function resolveAppUpdatePolicy(input: AppUpdatePolicyInput): AppUpdatePolicy;
export declare function mapAgentUpdateStatusToSnapshot(status: AgentUpdateStatus | null | undefined): ConnectedAgentUpdateSnapshot | null;
export declare function readNativeAppInfo(): Promise<NativeAppInfo | null>;
export declare function getApplicationUpdateSnapshot(options?: {
    desktop?: boolean;
    appName?: string;
    appId?: string | null;
    version?: string | null;
    build?: string | null;
}): Promise<ApplicationUpdateSnapshot>;
//# sourceMappingURL=update-policy.d.ts.map