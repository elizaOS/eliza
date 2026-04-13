import type { PermissionState } from "../api";

export type WebsiteBlockerSettingsMode = "desktop" | "mobile" | "web";

export interface WebsiteBlockerSettingsCardProps {
  mode: WebsiteBlockerSettingsMode;
  permission?: PermissionState;
  platform?: string;
  onOpenPermissionSettings?: () => void | Promise<void>;
  onRequestPermission?: () => void | Promise<void>;
}
