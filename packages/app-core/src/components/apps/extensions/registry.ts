import type { RegistryAppInfo } from "../../../api";
import type { AppDetailExtensionComponent } from "./types";

const DETAIL_EXTENSION_COMPONENTS: Record<string, AppDetailExtensionComponent> =
  {};

export function getAppDetailExtension(
  app: RegistryAppInfo,
): AppDetailExtensionComponent | null {
  const detailPanelId = app.uiExtension?.detailPanelId;
  if (!detailPanelId) return null;
  return DETAIL_EXTENSION_COMPONENTS[detailPanelId] ?? null;
}
