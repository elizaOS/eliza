import type {
  IPermissionsRegistry,
  PermissionId,
} from "@elizaos/core/permissions";
import { createContext, useContext, type ReactNode } from "react";
import {
  getLocationPlugin,
  getMobileSignalsPlugin,
  getPushNotificationsPlugin,
  getTalkModePlugin,
} from "../../bridge/native-plugins";
import type { WalkthroughMemoryStore } from "./permission-walkthrough";
export {
  adoptWalkthroughProgress,
  locationAccess,
  permissionStateAccess,
  photoLibraryAccess,
  walkthroughMemory,
  walkthroughProgress,
} from "./permission-walkthrough";

/** Installed native methods and existing UI memory; neither establishes permission. */
export interface PermissionPrimingHost {
  readonly supported: readonly PermissionId[];
  readonly registry: Pick<
    IPermissionsRegistry,
    "check" | "request" | "openSettings"
  >;
  readonly memory?: WalkthroughMemoryStore;
  readonly reopenEvent?: string;
}

const NativePermissionHostContext = createContext<
  PermissionPrimingHost | undefined
>(undefined);

export function NativePermissionHostProvider({
  host,
  children,
}: {
  host?: PermissionPrimingHost;
  children: ReactNode;
}) {
  return (
    <NativePermissionHostContext.Provider value={host}>
      {children}
    </NativePermissionHostContext.Provider>
  );
}

export const useNativePermissionHost = () =>
  useContext(NativePermissionHostContext);

/** A package dependency is not evidence that its native methods were installed. */
export function supportedNativePrimingPermissions(): PermissionId[] {
  const voice = getTalkModePlugin();
  const location = getLocationPlugin();
  const push = getPushNotificationsPlugin();
  const mobile = getMobileSignalsPlugin();
  const checkAndRequest = (value: {
    checkPermissions?: unknown;
    requestPermissions?: unknown;
  }) =>
    typeof value.checkPermissions === "function" &&
    typeof value.requestPermissions === "function";
  return [
    ...(checkAndRequest(push) || checkAndRequest(mobile)
      ? ["notifications" as const]
      : []),
    ...(checkAndRequest(voice) ? ["microphone" as const] : []),
    ...(checkAndRequest(location) ? ["location" as const] : []),
    // Camera's current generic request includes microphone and storage, and its
    // photos answer is not a library grant. Android Calendar also needs its own
    // requestAccess adapter. These entries require explicit scoped host ports.
  ];
}
