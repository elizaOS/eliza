import type { PluginInfo } from "../../api";
import { type TranslateFn } from "./plugin-list-utils";

interface PluginGameModalProps {
  effectiveGameSelected: string | null;
  gameMobileDetail: boolean;
  gameNarrow: boolean;
  gameVisiblePlugins: PluginInfo[];
  isConnectorLikeMode: boolean;
  pluginConfigs: Record<string, Record<string, string>>;
  pluginSaveSuccess: Set<string>;
  pluginSaving: Set<string>;
  resultLabel: string;
  saveLabel: string;
  savedLabel: string;
  savingLabel: string;
  sectionTitle: string;
  selectedPlugin: PluginInfo | null;
  selectedPluginLinks: Array<{
    key: string;
    url: string;
  }>;
  t: TranslateFn;
  togglingPlugins: Set<string>;
  onBack: () => void;
  onConfigSave: (pluginId: string) => Promise<void>;
  onOpenExternalUrl: (url: string) => Promise<void>;
  onParamChange: (pluginId: string, paramKey: string, value: string) => void;
  onSelectPlugin: (pluginId: string) => void;
  onTestConnection: (pluginId: string) => Promise<void>;
  onTogglePlugin: (pluginId: string, enabled: boolean) => Promise<void>;
}
export declare function PluginGameModal({
  effectiveGameSelected,
  gameMobileDetail,
  gameNarrow,
  gameVisiblePlugins,
  isConnectorLikeMode,
  pluginConfigs,
  pluginSaveSuccess,
  pluginSaving,
  resultLabel,
  saveLabel,
  savedLabel,
  savingLabel,
  sectionTitle,
  selectedPlugin,
  selectedPluginLinks,
  t,
  togglingPlugins,
  onBack,
  onConfigSave,
  onOpenExternalUrl,
  onParamChange,
  onSelectPlugin,
  onTestConnection,
  onTogglePlugin,
}: PluginGameModalProps): import("react/jsx-runtime").JSX.Element;
//# sourceMappingURL=plugin-view-modal.d.ts.map
