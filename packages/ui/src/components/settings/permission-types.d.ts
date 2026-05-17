import type { PermissionId, PermissionStatus } from "../../api";
/** Permission definition for UI rendering. */
export interface PermissionDef {
  id: PermissionId;
  name: string;
  nameKey: string;
  description: string;
  descriptionKey: string;
  icon: string;
  platforms: string[];
  requiredForFeatures: string[];
}
export declare const SYSTEM_PERMISSIONS: PermissionDef[];
/** Capability toggle definition. */
export interface CapabilityDef {
  id: string;
  label: string;
  labelKey: string;
  description: string;
  descriptionKey: string;
  requiredPermissions: PermissionId[];
}
export declare const CAPABILITIES: CapabilityDef[];
export declare const PERMISSION_BADGE_LABELS: Record<
  PermissionStatus,
  {
    defaultLabel: string;
    labelKey: string;
    tone: "success" | "danger" | "warning" | "muted";
  }
>;
/** Reusable settings-panel Tailwind class names. */
export declare const SETTINGS_PANEL_CLASSNAME =
  "rounded border border-border/60 bg-bg/40 p-4 space-y-4";
export declare const SETTINGS_PANEL_HEADER_CLASSNAME =
  "flex flex-wrap items-start justify-between gap-3";
export declare const SETTINGS_PANEL_ACTIONS_CLASSNAME =
  "flex items-center gap-2";
export declare const SETTINGS_REFRESH_DELAYS_MS: readonly [1500, 4000];
export declare function translateWithFallback(
  t: (key: string) => string,
  key: string,
  fallback: string,
): string;
export declare function getPermissionAction(
  t: (key: string) => string,
  id: PermissionId,
  status: PermissionStatus,
  canRequest: boolean,
  platform?: string,
): {
  ariaLabelPrefix: string;
  label: string;
  type: "request" | "settings";
} | null;
export declare function getPermissionBadge(
  t: (key: string) => string,
  id: PermissionId,
  status: PermissionStatus,
  platform: string,
): {
  tone: "success" | "danger" | "warning" | "muted";
  label: string;
};
//# sourceMappingURL=permission-types.d.ts.map
