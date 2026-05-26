import type { client as appClient } from "../api/client";

// ── desktop-permissions-client ──────────────────────────────────────────

export type PermissionsClientLike = Pick<
  typeof appClient,
  | "getPermissions"
  | "getPermission"
  | "requestPermission"
  | "openPermissionSettings"
  | "refreshPermissions"
  | "setShellEnabled"
  | "isShellEnabled"
>;

export type PermissionsPatchState = {
  getPermissions: PermissionsClientLike["getPermissions"];
  getPermission: PermissionsClientLike["getPermission"];
  requestPermission: PermissionsClientLike["requestPermission"];
  openPermissionSettings: PermissionsClientLike["openPermissionSettings"];
  refreshPermissions: PermissionsClientLike["refreshPermissions"];
  setShellEnabled: PermissionsClientLike["setShellEnabled"];
  isShellEnabled: PermissionsClientLike["isShellEnabled"];
};

// ── first-run-reset ────────────────────────────────────────────────────

export type FirstRunClientLike = Pick<
  typeof appClient,
  "getConfig" | "getFirstRunStatus" | "submitFirstRun"
>;

export type FirstRunPatchState = {
  getConfig: FirstRunClientLike["getConfig"];
  getFirstRunStatus: FirstRunClientLike["getFirstRunStatus"];
  submitFirstRun: FirstRunClientLike["submitFirstRun"];
};

// ── cloud-preference-patch ──────────────────────────────────────────────

export type CloudPreferenceClientLike = Pick<
  typeof appClient,
  "getCloudStatus" | "getConfig"
> & {
  getCloudCredits?: typeof appClient.getCloudCredits;
};

export type CloudPreferencePatchState = {
  getConfig: CloudPreferenceClientLike["getConfig"];
  getCloudStatus: CloudPreferenceClientLike["getCloudStatus"];
  getCloudCredits?: CloudPreferenceClientLike["getCloudCredits"];
};

// ── shared browser-like abstractions ────────────────────────────────────

export type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;
export type HistoryLike = Pick<History, "replaceState">;
