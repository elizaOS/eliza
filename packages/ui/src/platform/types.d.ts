import type { client as appClient } from "../api/client";
export type PermissionsClientLike = Pick<typeof appClient, "getPermissions" | "getPermission" | "requestPermission" | "openPermissionSettings" | "refreshPermissions" | "setShellEnabled" | "isShellEnabled">;
export type PermissionsPatchState = {
    getPermissions: PermissionsClientLike["getPermissions"];
    getPermission: PermissionsClientLike["getPermission"];
    requestPermission: PermissionsClientLike["requestPermission"];
    openPermissionSettings: PermissionsClientLike["openPermissionSettings"];
    refreshPermissions: PermissionsClientLike["refreshPermissions"];
    setShellEnabled: PermissionsClientLike["setShellEnabled"];
    isShellEnabled: PermissionsClientLike["isShellEnabled"];
};
export type OnboardingClientLike = Pick<typeof appClient, "getConfig" | "getOnboardingStatus" | "submitOnboarding">;
export type OnboardingPatchState = {
    getConfig: OnboardingClientLike["getConfig"];
    getOnboardingStatus: OnboardingClientLike["getOnboardingStatus"];
    submitOnboarding: OnboardingClientLike["submitOnboarding"];
};
export type CloudPreferenceClientLike = Pick<typeof appClient, "getCloudStatus" | "getConfig"> & {
    getCloudCredits?: typeof appClient.getCloudCredits;
};
export type CloudPreferencePatchState = {
    getConfig: CloudPreferenceClientLike["getConfig"];
    getCloudStatus: CloudPreferenceClientLike["getCloudStatus"];
    getCloudCredits?: CloudPreferenceClientLike["getCloudCredits"];
};
export type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;
export type HistoryLike = Pick<History, "replaceState">;
//# sourceMappingURL=types.d.ts.map