import type {
  IPermissionsRegistry,
  PermissionId,
  PermissionState,
} from "@elizaos/shared";
import {
  type AppleCalendarPluginLike,
  type MobileSignalsOpenSettingsResult,
  type MobileSignalsPluginLike,
  type PushNotificationsPluginLike,
} from "../bridge/native-plugins";

type PermissionClientLike = {
  getPermission(id: PermissionId): Promise<PermissionState>;
  requestPermission(id: PermissionId): Promise<PermissionState>;
  openPermissionSettings(id: PermissionId): Promise<void>;
};
export declare function openMobilePermissionSettings(
  id: PermissionId,
  plugin?: MobileSignalsPluginLike,
): Promise<MobileSignalsOpenSettingsResult | undefined>;
export declare function createMobileSignalsPermissionsRegistry(
  plugin?: MobileSignalsPluginLike,
  fallbackClient?: PermissionClientLike,
  appleCalendarPlugin?: AppleCalendarPluginLike,
  pushNotificationsPlugin?: PushNotificationsPluginLike,
): IPermissionsRegistry;
//# sourceMappingURL=mobile-permissions-client.d.ts.map
