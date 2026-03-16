import type { RegistryAppInfo } from "../../../api";
import { HyperscapeAppDetailPanel } from "./HyperscapeAppDetailPanel";
import type { AppDetailExtensionComponent } from "./types";

const DETAIL_EXTENSION_COMPONENTS: Record<string, AppDetailExtensionComponent> =
  {
    "hyperscape-embedded-agents": HyperscapeAppDetailPanel,
  };

export function getAppDetailExtension(
  app: RegistryAppInfo,
): AppDetailExtensionComponent | null {
  const detailPanelId = app.uiExtension?.detailPanelId;
  if (!detailPanelId) return null;
  return DETAIL_EXTENSION_COMPONENTS[detailPanelId] ?? null;
}
