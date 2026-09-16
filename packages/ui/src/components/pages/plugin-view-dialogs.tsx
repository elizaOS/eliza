/**
 * The plugin settings dialog for `PluginsView`: shows a plugin's config form,
 * install progress, save/test results, and install/reset/save actions in a
 * modal. Fully controlled — all state and callbacks are owned by the parent
 * view and passed in as props.
 */
import { CheckCircle2 } from "lucide-react";
import { useAgentElement } from "../../agent-surface";
import type { PluginInfo } from "../../api";
import { ConnectorSetupPanel } from "../connectors/ConnectorSetupPanel";
import { AdminDialog } from "../ui/admin-dialog";
import { Avatar, AvatarImage } from "../ui/avatar";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Dialog, DialogDescription, DialogTitle } from "../ui/dialog";
import { PluginConfigForm } from "./PluginConfigForm";
import {
  iconImageSource,
  resolveIcon,
  type TranslateFn,
} from "./plugin-list-utils";
import type { PluginConnectionTestResult } from "./plugin-view-connectors";

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
      <Avatar shape="square" className="size-6">
        <AvatarImage
          src={imageSrc}
          alt=""
          className="object-contain"
          onError={(event) => {
            event.currentTarget.style.display = "none";
          }}
        />
      </Avatar>
    ) : (
      <span className="text-base">{icon}</span>
    );
  }
  const IconComponent = icon;
  return <IconComponent className="size-6  text-txt" />;
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
  const dialogPluginId = settingsDialogPlugin?.id;
  const installControl = useAgentElement<HTMLButtonElement>({
    id: "plugin-dialog-install",
    role: "button",
    label: "Install plugin",
    group: "plugin-dialog",
    description: "Install the plugin package",
    onActivate: () => {
      if (settingsDialogPlugin) {
        void onInstallPlugin(
          settingsDialogPlugin.id,
          settingsDialogPlugin.npmName ?? "",
        );
      }
    },
  });
  const testControl = useAgentElement<HTMLButtonElement>({
    id: "plugin-dialog-test",
    role: "button",
    label: "Test connection",
    group: "plugin-dialog",
    description: "Run a connection test for the plugin",
    onActivate: () => {
      if (dialogPluginId) void onTestConnection(dialogPluginId);
    },
  });
  const resetControl = useAgentElement<HTMLButtonElement>({
    id: "plugin-dialog-reset",
    role: "button",
    label: "Reset settings",
    group: "plugin-dialog",
    description: "Discard unsaved configuration changes",
    onActivate: () => {
      if (dialogPluginId) onConfigReset(dialogPluginId);
    },
  });
  const saveControl = useAgentElement<HTMLButtonElement>({
    id: "plugin-dialog-save",
    role: "button",
    label: "Save settings",
    group: "plugin-dialog",
    description: "Save the plugin configuration",
    onActivate: () => {
      if (dialogPluginId) void onConfigSave(dialogPluginId);
    },
  });

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
            <Badge variant="metaAccent" size="compact">
              {t("pluginsview.DEMO")}
            </Badge>
          )}
        </AdminDialog.Header>
        <AdminDialog.BodyScroll>
          <div className="px-5 pt-4 pb-1 flex items-center gap-3 text-xs text-muted">
            {plugin.description && (
              <span
                className="min-w-0 flex-1 line-clamp-1 text-xs text-muted"
                title={plugin.description}
              >
                {plugin.description}
              </span>
            )}
            {(plugin.tags?.length ?? 0) > 0 && (
              <span className="flex shrink-0 items-center gap-1.5">
                {plugin.tags?.map((tag) => (
                  <Badge
                    key={`${plugin.id}:${tag}:settings`}
                    variant="metaDefault"
                    size="micro"
                    className="max-w-24 truncate lowercase"
                    title={tag}
                  >
                    {tag}
                  </Badge>
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
                    <Badge key={dep} variant="metaAccent" size="micro">
                      {dep}
                    </Badge>
                  ))}
                </span>
              )}
            </div>
          )}

          <div className="px-5 py-3">
            <PluginConfigForm
              plugin={plugin}
              pluginConfigs={pluginConfigs}
              onParamChange={onParamChange}
            />
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
                  ref={installControl.ref}
                  variant="default"
                  size="denseWide"
                  disabled={installingPlugins.has(plugin.id)}
                  onClick={() =>
                    void onInstallPlugin(plugin.id, plugin.npmName ?? "")
                  }
                  {...installControl.agentProps}
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
                size="denseWide"
                disabled={testResults.get(plugin.id)?.loading}
                onClick={() => void onTestConnection(plugin.id)}
                ref={testControl.ref}
                {...testControl.agentProps}
              >
                {formatDialogTestConnectionLabel(testResults.get(plugin.id))}
              </Button>
            )}
            <Button
              ref={resetControl.ref}
              variant="ghostMuted"
              size="denseWide"
              onClick={() => onConfigReset(plugin.id)}
              {...resetControl.agentProps}
            >
              {t("common.reset")}
            </Button>
            <Button
              ref={saveControl.ref}
              variant={saveSuccess ? "default" : "secondary"}
              size="denseWide"
              onClick={() => void onConfigSave(plugin.id)}
              disabled={isSaving}
              {...saveControl.agentProps}
            >
              {isSaving ? (
                savingLabel
              ) : saveSuccess ? (
                <>
                  <CheckCircle2 className="size-3.5" />
                  {t("pluginsview.Saved", {
                    defaultValue: "Saved",
                  })}
                </>
              ) : (
                saveSettingsLabel
              )}
            </Button>
          </AdminDialog.Footer>
        )}
      </AdminDialog.Content>
    </Dialog>
  );
}
