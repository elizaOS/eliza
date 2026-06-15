export type MobileSignalSetupStatus = "ready" | "unavailable" | string;

export interface MobileSignalSetupActionLike {
  id: string;
  label: string;
  status: MobileSignalSetupStatus;
  canRequest: boolean;
}

export type MobileSignalPermissionTarget =
  | "health"
  | "screenTime"
  | "notifications";

export interface MobileSignalSetupTranslateOptions {
  defaultValue?: string;
}

export type MobileSignalSetupTranslate = (
  key: string,
  options?: MobileSignalSetupTranslateOptions,
) => string;

export function mobileSignalSetupActionBadge(
  action: MobileSignalSetupActionLike,
  t: MobileSignalSetupTranslate,
): { variant: "secondary" | "outline"; label: string } {
  if (action.status === "ready") {
    return {
      variant: "secondary",
      label: t("lifeopssettings.deviceSetupReady", { defaultValue: "Ready" }),
    };
  }
  if (action.status === "unavailable") {
    return {
      variant: "outline",
      label: t("lifeopssettings.deviceSetupUnavailable", {
        defaultValue: "Unavailable",
      }),
    };
  }
  return {
    variant: "outline",
    label: t("lifeopssettings.deviceSetupNeedsAction", {
      defaultValue: "Needs action",
    }),
  };
}

export function mobileSignalSetupPrimaryActionLabel(
  action: MobileSignalSetupActionLike,
  t: MobileSignalSetupTranslate,
): string {
  if (action.canRequest) {
    return t("lifeopssettings.deviceSetupGrant", { defaultValue: "Grant" });
  }
  return t("lifeopssettings.deviceSetupOpenSettings", {
    defaultValue: "Open Settings",
  });
}

export function mobileSignalPermissionTargetForAction(
  action: Pick<MobileSignalSetupActionLike, "id">,
): MobileSignalPermissionTarget | null {
  if (action.id === "health_permissions") return "health";
  if (action.id === "screen_time_authorization") return "screenTime";
  if (action.id === "notification_settings") return "notifications";
  return null;
}
