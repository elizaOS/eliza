import {
  AdminDialog,
  Button,
  Dialog,
  DialogDescription,
  DialogTitle,
} from "@elizaos/ui";
import type { PluginInfo } from "../../api";
import { ConnectorSetupPanel } from "../connectors/ConnectorSetupPanel";
import { PluginConfigForm, TelegramPluginConfig } from "./PluginConfigForm";
import {
  iconImageSource,
  resolveIcon,
  type TranslateFn,
} from "./plugin-list-utils";

type PluginConnectionTestResult = {
  durationMs: number;
  error?: string;
  loading: boolean;
  message?: string;
  success: boolean;
};

interface PluginSettingsDialogProps {
  installPluginLabel: string;
  installProgress: Map<string, { message: string; phase: string }>;
  installingPlugins: Set<string>;
  pluginConfigs: Record<string, Record<string, string>>;
  pluginSaveSuccess: Set<string>;
  pluginSaving: Set<string>;
  settingsDialogPlugin: PluginInfo | null;
  t: TranslateFn;
  testResults: Map<string, PluginConnectionTestResult>;
  onClose: (pluginId: string) => void;
  onConfigReset: (pluginId: string) => void;
  onConfigSave: (pluginId: string) => Promise<void>;
  onInstallPlugin: (pluginId: string, npmName: string) => Promise<void>;
  onParamChange: (pluginId: string, paramKey: string, value: string) => void;
  onTestConnection: (pluginId: string) => Promise<void>;
  formatDialogTestConnectionLabel: (
    result?: PluginConnectionTestResult,
  ) => string;
  installProgressLabel: (message?: string) => string;
  saveSettingsLabel: string;
  savingLabel: string;
}

function SettingsDialogIcon({ plugin }: { plugin: PluginInfo }) {
  const icon = resolveIcon(plugin);
  if (!icon) return null;
  if (typeof icon === "string") {
    const imageSrc = iconImageSource(icon);
    return imageSrc ? (
      <img
        src={imageSrc}
        alt=""
        className="w-6 h-6 rounded-md object-contain"
        onError={(event) => {
          (event.currentTarget as HTMLImageElement).style.display = "none";
        }}
      />
    ) : (
      <span className="text-base">{icon}</span>
    );
  }
  const IconComponent = icon;
  return <IconComponent className="w-6 h-6 text-txt" />;
}

export function PluginSettingsDialog({
  installPluginLabel,
  installProgress,
  installingPlugins,
  pluginConfigs,
  pluginSaveSuccess,
  pluginSaving,
  settingsDialogPlugin,
  t,
  testResults,
  onClose,
  onConfigReset,
  onConfigSave,
  onInstallPlugin,
  onParamChange,
  onTestConnection,
  formatDialogTestConnectionLabel,
  installProgressLabel,
  saveSettingsLabel,
  savingLabel,
}: PluginSettingsDialogProps) {
  if (!settingsDialogPlugin) return null;

  const plugin = settingsDialogPlugin;
  const isShowcase = plugin.id === "__ui-showcase__";
  const isSaving = pluginSaving.has(plugin.id);
  const saveSuccess = pluginSaveSuccess.has(plugin.id);
  const categoryLabel = isShowcase
    ? "showcase"
    : plugin.category === "ai-provider"
      ? "ai provider"
      : plugin.category;

  return (
    <Dialog
      open
      onOpenChange={(open: boolean) => {
        if (!open) onClose(plugin.id);
      }}
    >
      <AdminDialog.Content className="max-h-[85vh] max-w-2xl">
        <AdminDialog.Header className="flex flex-row items-center gap-3">
          <DialogTitle className="font-bold text-base flex items-center gap-2 flex-1 min-w-0 tracking-wide text-txt">
            <SettingsDialogIcon plugin={plugin} />
            {plugin.name}
          </DialogTitle>
          <DialogDescription className="sr-only">
            {t("pluginsview.PluginDialogDescription", {
              plugin: plugin.name,
              defaultValue:
                "Review plugin metadata, adjust settings, and save changes for {{plugin}}.",
            })}
          </DialogDescription>
          <AdminDialog.MetaBadge>{categoryLabel}</AdminDialog.MetaBadge>
          {plugin.version && (
            <AdminDialog.MonoMeta>v{plugin.version}</AdminDialog.MonoMeta>
          )}
          {isShowcase && (
            <span className="text-2xs font-bold tracking-widest px-2.5 py-[2px] border border-accent/30 text-txt bg-accent/10 rounded-full">
              {t("pluginsview.DEMO")}
            </span>
          )}
        </AdminDialog.Header>
        <AdminDialog.BodyScroll>
          <div className="px-5 pt-4 pb-1 flex items-center gap-3 flex-wrap text-xs text-muted">
            {plugin.description && (
              <span className="text-xs text-muted leading-relaxed">
                {plugin.description}
              </span>
            )}
            {(plugin.tags?.length ?? 0) > 0 && (
              <span className="flex items-center gap-1.5 flex-wrap">
                {plugin.tags?.map((tag) => (
                  <span
                    key={`${plugin.id}:${tag}:settings`}
                    className="whitespace-nowrap border border-border/40 bg-bg-accent/80 px-1.5 py-px text-2xs lowercase tracking-wide text-muted-strong"
                  >
                    {tag}
                  </span>
                ))}
              </span>
            )}
          </div>
          {(plugin.npmName ||
            (plugin.pluginDeps && plugin.pluginDeps.length > 0)) && (
            <div className="px-5 pb-2 flex items-center gap-3 flex-wrap">
              {plugin.npmName && (
                <span className="font-mono text-2xs text-muted opacity-50">
                  {plugin.npmName}
                </span>
              )}
              {plugin.pluginDeps && plugin.pluginDeps.length > 0 && (
                <span className="flex items-center gap-1 flex-wrap">
                  <span className="text-2xs text-muted opacity-60">
                    {t("pluginsview.dependsOn")}
                  </span>
                  {plugin.pluginDeps.map((dep: string) => (
                    <span
                      key={dep}
                      className="text-2xs px-1.5 py-px border border-border bg-accent-subtle text-muted rounded-sm"
                    >
                      {dep}
                    </span>
                  ))}
                </span>
              )}
            </div>
          )}

          <div className="px-5 py-3">
            {plugin.id === "telegram" ? (
              <TelegramPluginConfig
                plugin={plugin}
                pluginConfigs={pluginConfigs}
                onParamChange={onParamChange}
              />
            ) : (
              <PluginConfigForm
                plugin={plugin}
                pluginConfigs={pluginConfigs}
                onParamChange={onParamChange}
              />
            )}
            <ConnectorSetupPanel pluginId={plugin.id} />
          </div>
        </AdminDialog.BodyScroll>
        {!isShowcase && (
          <AdminDialog.Footer className="flex justify-end gap-3">
            {plugin.source === "store" &&
              plugin.enabled &&
              !plugin.isActive &&
              plugin.npmName &&
              !plugin.loadError && (
                <Button
                  variant="default"
                  size="sm"
                  className="h-8 px-4 text-xs-tight font-bold tracking-wide shadow-sm"
                  disabled={installingPlugins.has(plugin.id)}
                  onClick={() =>
                    void onInstallPlugin(plugin.id, plugin.npmName ?? "")
                  }
                >
                  {installingPlugins.has(plugin.id)
                    ? installProgressLabel(
                        installProgress.get(plugin.npmName ?? "")?.message,
                      )
                    : installPluginLabel}
                </Button>
              )}
            {plugin.loadError && (
              <span
                className="px-3 py-1.5 text-xs-tight text-danger font-bold tracking-wide"
                title={plugin.loadError}
              >
                {t("pluginsview.PackageBrokenMis")}
              </span>
            )}
            {plugin.isActive && (
              <Button
                variant={
                  testResults.get(plugin.id)?.success
                    ? "default"
                    : testResults.get(plugin.id)?.error
                      ? "destructive"
                      : "outline"
                }
                size="sm"
                className={`h-8 px-4 text-xs-tight font-bold tracking-wide transition-all ${
                  testResults.get(plugin.id)?.loading
                    ? "opacity-70 cursor-wait"
                    : testResults.get(plugin.id)?.success
                      ? "bg-ok text-ok-fg border-ok hover:bg-ok/90"
                      : testResults.get(plugin.id)?.error
                        ? "bg-danger text-danger-fg border-danger hover:bg-danger/90"
                        : "border-border/40 bg-card/40 backdrop-blur-md shadow-sm hover:border-accent/40"
                }`}
                disabled={testResults.get(plugin.id)?.loading}
                onClick={() => void onTestConnection(plugin.id)}
              >
                {formatDialogTestConnectionLabel(testResults.get(plugin.id))}
              </Button>
            )}
            <Button
              variant="ghost"
              size="sm"
              className="h-8 px-4 text-xs font-bold text-muted hover:text-txt transition-all"
              onClick={() => onConfigReset(plugin.id)}
            >
              {t("common.reset")}
            </Button>
            <Button
              variant={saveSuccess ? "default" : "secondary"}
              size="sm"
              className={`h-8 px-5 text-xs font-bold tracking-wide transition-all ${
                saveSuccess
                  ? "bg-ok text-ok-fg hover:bg-ok/90"
                  : "bg-accent text-accent-fg hover:bg-accent/90 shadow-lg shadow-accent/20"
              }`}
              onClick={() => void onConfigSave(plugin.id)}
              disabled={isSaving}
            >
              {isSaving
                ? savingLabel
                : saveSuccess
                  ? t("pluginsview.SavedWithCheck", {
                      defaultValue: "✓ Saved",
                    })
                  : saveSettingsLabel}
            </Button>
          </AdminDialog.Footer>
        )}
      </AdminDialog.Content>
    </Dialog>
  );
}
