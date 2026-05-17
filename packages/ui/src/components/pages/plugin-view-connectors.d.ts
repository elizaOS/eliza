import { type ReactNode, type RefCallback } from "react";
import { type PluginInfo } from "../../api";
import { type TranslateFn } from "./plugin-list-utils";
export interface PluginConnectionTestResult {
  durationMs: number;
  error?: string;
  loading: boolean;
  message?: string;
  success: boolean;
}
interface ConnectorPluginGroupsProps {
  collapseLabel: string;
  connectorExpandedIds: Set<string>;
  connectorInstallPrompt: string;
  connectorSelectedId: string | null;
  expandLabel: string;
  formatSaveSettingsLabel: (isSaving: boolean, didSave: boolean) => string;
  formatTestConnectionLabel: (result?: PluginConnectionTestResult) => string;
  handleConfigReset: (pluginId: string) => void;
  handleConfigSave: (pluginId: string) => Promise<void>;
  handleConnectorExpandedChange: (
    pluginId: string,
    nextExpanded: boolean,
  ) => void;
  handleConnectorSectionToggle: (pluginId: string) => void;
  handleInstallPlugin: (pluginId: string, npmName: string) => Promise<void>;
  handleOpenPluginExternalUrl: (url: string) => Promise<void>;
  handleParamChange: (
    pluginId: string,
    paramKey: string,
    value: string,
  ) => void;
  handleTestConnection: (pluginId: string) => Promise<void>;
  handleTogglePlugin: (pluginId: string, enabled: boolean) => Promise<void>;
  hasPluginToggleInFlight: boolean;
  installPluginLabel: string;
  installProgress: Map<
    string,
    {
      message: string;
      phase: string;
    }
  >;
  installingPlugins: Set<string>;
  installProgressLabel: (message?: string) => string;
  loadFailedLabel: string;
  needsSetupLabel: string;
  noConfigurationNeededLabel: string;
  notInstalledLabel: string;
  pluginConfigs: Record<string, Record<string, string>>;
  pluginDescriptionFallback: string;
  pluginSaveSuccess: Set<string>;
  pluginSaving: Set<string>;
  readyLabel: string;
  registerConnectorContentItem: (pluginId: string) => RefCallback<HTMLElement>;
  renderResolvedIcon: (
    plugin: PluginInfo,
    options?: {
      className?: string;
      emojiClassName?: string;
    },
  ) => ReactNode;
  t: TranslateFn;
  testResults: Map<string, PluginConnectionTestResult>;
  togglingPlugins: Set<string>;
  visiblePlugins: PluginInfo[];
}
export declare function ConnectorPluginGroups(
  props: ConnectorPluginGroupsProps,
): import("react/jsx-runtime").JSX.Element[];
//# sourceMappingURL=plugin-view-connectors.d.ts.map
