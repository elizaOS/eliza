import type { RegistryAppInfo } from "../../../api";
import { BabylonDetailExtension } from "./BabylonDetailExtension";
import { DefenseAgentsDetailExtension } from "./DefenseAgentsDetailExtension";
import { HyperscapeDetailExtension } from "./HyperscapeDetailExtension";
import { TwoThousandFourScapeDetailExtension } from "./TwoThousandFourScapeDetailExtension";
import type { AppDetailExtensionComponent } from "./types";

const DETAIL_EXTENSION_COMPONENTS: Record<string, AppDetailExtensionComponent> =
  {
    "babylon-operator-dashboard": BabylonDetailExtension,
    "defense-agent-control": DefenseAgentsDetailExtension,
    "hyperscape-embedded-agents": HyperscapeDetailExtension,
    "2004scape-operator-dashboard": TwoThousandFourScapeDetailExtension,
  };

export function getAppDetailExtension(
  app: RegistryAppInfo,
): AppDetailExtensionComponent | null {
  const detailPanelId = app.uiExtension?.detailPanelId;
  if (!detailPanelId) return null;
  return DETAIL_EXTENSION_COMPONENTS[detailPanelId] ?? null;
}
