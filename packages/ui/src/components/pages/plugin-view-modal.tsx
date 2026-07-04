/**
 * Full-screen "game/app" plugin modal for the Plugins view: a master/detail
 * surface listing installable plugin apps on the left and the selected plugin's
 * config, connector setup, and enable/disable toggle on the right. Purely
 * presentational — all plugin state, config values, and action callbacks are
 * passed in as props by the parent PluginsView.
 */

import { CheckCircle2, Puzzle, XCircle } from "lucide-react";
import type { CSSProperties, ReactNode } from "react";
import { useAgentElement } from "../../agent-surface";
import type { PluginInfo, PluginParamDef } from "../../api";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import {
  iconImageSource,
  pluginResourceLinkLabel,
  resolveIcon,
  type TranslateFn,
} from "./plugin-list-utils";

function PluginGameListCard({
  plugin,
  isSelected,
  icon,
  enabledLabel,
  disabledLabel,
  onSelect,
}: {
  plugin: PluginInfo;
  isSelected: boolean;
  icon: ReactNode;
  enabledLabel: string;
  disabledLabel: string;
  onSelect: (pluginId: string) => void;
}) {
  const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
    id: `plugin-game-card-${plugin.id}`,
    role: "list-item",
    label: plugin.name,
    group: "plugin-game-list",
    status: isSelected ? "active" : "inactive",
    description: `Select the ${plugin.name} plugin`,
    onActivate: () => onSelect(plugin.id),
  });
  return (
    <Button
      ref={ref}
      variant="ghost"
      type="button"
      role="option"
      aria-selected={isSelected}
      className={`plugins-game-card${isSelected ? " is-selected" : ""}${
        !plugin.enabled ? " is-disabled" : ""
      } h-auto`}
      onClick={() => onSelect(plugin.id)}
      {...agentProps}
    >
      <div className="plugins-game-card-icon-shell">
        <span className="plugins-game-card-icon">{icon}</span>
      </div>
      <div className="plugins-game-card-body">
        <div className="plugins-game-card-name">{plugin.name}</div>
        <div className="plugins-game-card-meta">
          <span
            className={`plugins-game-badge ${
              plugin.enabled ? "is-on" : "is-off"
            }`}
            title={plugin.enabled ? enabledLabel : disabledLabel}
          >
            {plugin.enabled ? (
              <CheckCircle2 className="h-3 w-3" />
            ) : (
              <XCircle className="h-3 w-3" />
            )}
            <span className="sr-only">
              {plugin.enabled ? enabledLabel : disabledLabel}
            </span>
          </span>
        </div>
      </div>
    </Button>
  );
}

function PluginGameResourceLink({
  pluginId,
  linkKey,
  url,
  label,
  onOpen,
}: {
  pluginId: string;
  linkKey: string;
  url: string;
  label: string;
  onOpen: (url: string) => void;
}) {
  const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
    id: `plugin-game-${pluginId}-link-${linkKey}`,
    role: "link",
    label: `${label} (${pluginId})`,
    group: "plugin-game-detail",
    description: `Open ${label} for ${pluginId}`,
    onActivate: () => onOpen(url),
  });
  return (
    <Button
      ref={ref}
      variant="outline"
      size="sm"
      type="button"
      className="plugins-game-link-btn border border-border bg-transparent px-2.5 py-1 text-xs-tight text-muted transition-colors hover:border-accent hover:text-txt"
      onClick={() => {
        void onOpen(url);
      }}
      {...agentProps}
    >
      {label}
    </Button>
  );
}

function PluginGameParamField({
  pluginId,
  param,
  value,
  onParamChange,
}: {
  pluginId: string;
  param: PluginParamDef;
  value: string;
  onParamChange: (pluginId: string, paramKey: string, value: string) => void;
}) {
  const { ref, agentProps } = useAgentElement<HTMLInputElement>({
    id: `plugin-game-${pluginId}-param-${param.key}`,
    role: "text-input",
    label: `${param.key} (${pluginId})`,
    group: "plugin-game-detail",
    description: param.description || `Set ${param.key}`,
    getValue: () => value,
    onFill: (next) => onParamChange(pluginId, param.key, next),
  });
  return (
    <div id={`field-${param.key}`}>
      <label
        htmlFor={`input-${param.key}`}
        className="text-xs-tight tracking-wider text-muted block mb-1"
      >
        {param.key}
      </label>
      <Input
        ref={ref}
        id={`input-${param.key}`}
        type={param.sensitive ? "password" : "text"}
        className="w-full px-2 py-1 text-xs"
        placeholder={param.description}
        value={value}
        onChange={(event) =>
          onParamChange(pluginId, param.key, event.target.value)
        }
        {...agentProps}
      />
    </div>
  );
}

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
  selectedPluginLinks: Array<{ key: string; url: string }>;
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

function ResolvedPluginIcon({
  plugin,
  emojiClassName,
  iconClassName,
  imageClassName,
  imageStyle,
}: {
  plugin: PluginInfo;
  emojiClassName?: string;
  iconClassName?: string;
  imageClassName?: string;
  imageStyle?: CSSProperties;
}) {
  const icon = resolveIcon(plugin);
  if (!icon) return <Puzzle className={iconClassName} />;
  if (typeof icon === "string") {
    const imageSrc = iconImageSource(icon);
    return imageSrc ? (
      <img
        src={imageSrc}
        alt=""
        className={imageClassName}
        style={imageStyle}
      />
    ) : (
      <Puzzle className={iconClassName ?? emojiClassName} />
    );
  }
  const IconComponent = icon;
  return <IconComponent className={iconClassName} />;
}

export function PluginGameModal({
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
}: PluginGameModalProps) {
  const backControl = useAgentElement<HTMLButtonElement>({
    id: "plugin-game-back",
    role: "button",
    label: "Back to list",
    group: "plugin-game-detail",
    description: "Return to the plugin list",
    onActivate: () => onBack(),
  });
  const toggleControl = useAgentElement<HTMLButtonElement>({
    id: "plugin-game-toggle",
    role: "toggle",
    label: selectedPlugin ? `Toggle ${selectedPlugin.name}` : "Toggle plugin",
    group: "plugin-game-detail",
    status: selectedPlugin?.enabled ? "active" : "inactive",
    description: "Enable or disable the selected plugin",
    onActivate: () => {
      if (selectedPlugin) {
        void onTogglePlugin(selectedPlugin.id, !selectedPlugin.enabled);
      }
    },
  });
  const testControl = useAgentElement<HTMLButtonElement>({
    id: "plugin-game-test",
    role: "button",
    label: "Test connection",
    group: "plugin-game-detail",
    description: "Run a connection test for the selected plugin",
    onActivate: () => {
      if (selectedPlugin) void onTestConnection(selectedPlugin.id);
    },
  });
  const saveControl = useAgentElement<HTMLButtonElement>({
    id: "plugin-game-save",
    role: "button",
    label: "Save plugin configuration",
    group: "plugin-game-detail",
    description: "Save the configuration for the selected plugin",
    onActivate: () => {
      if (selectedPlugin) void onConfigSave(selectedPlugin.id);
    },
  });

  return (
    <div className="plugins-game-modal plugins-game-modal--inline">
      <div
        className={`plugins-game-list-panel${
          gameNarrow && gameMobileDetail ? " is-hidden" : ""
        }`}
      >
        <div className="plugins-game-list-head">
          <div className="plugins-game-section-title">{sectionTitle}</div>
        </div>
        <div
          className="plugins-game-list-scroll"
          role="listbox"
          aria-label={`${sectionTitle} list`}
        >
          {gameVisiblePlugins.length === 0 ? (
            <div className="plugins-game-list-empty">
              {t("pluginsview.NoResultsFound", {
                label: resultLabel,
                defaultValue: "No {{label}} found",
              })}
            </div>
          ) : (
            gameVisiblePlugins.map((plugin) => (
              <PluginGameListCard
                key={plugin.id}
                plugin={plugin}
                isSelected={effectiveGameSelected === plugin.id}
                enabledLabel={t("common.on")}
                disabledLabel={t("common.off")}
                icon={
                  <ResolvedPluginIcon
                    plugin={plugin}
                    imageClassName="plugins-game-card-icon"
                    imageStyle={{ objectFit: "contain" }}
                    iconClassName="w-5 h-5"
                  />
                }
                onSelect={onSelectPlugin}
              />
            ))
          )}
        </div>
      </div>
      <div
        className={`plugins-game-detail-panel${
          gameNarrow && !gameMobileDetail ? " is-hidden" : ""
        }`}
      >
        {selectedPlugin ? (
          <>
            <div className="plugins-game-detail-head">
              {gameNarrow && (
                <Button
                  ref={backControl.ref}
                  variant="ghost"
                  size="sm"
                  type="button"
                  className="plugins-game-back-btn"
                  onClick={onBack}
                  {...backControl.agentProps}
                >
                  {t("common.back")}
                </Button>
              )}
              <div className="plugins-game-detail-title-row">
                <div className="plugins-game-detail-icon-shell">
                  <span className="plugins-game-detail-icon">
                    <ResolvedPluginIcon
                      plugin={selectedPlugin}
                      imageClassName="plugins-game-detail-icon"
                      iconClassName="w-6 h-6"
                    />
                  </span>
                </div>
                <div className="plugins-game-detail-main">
                  <div className="plugins-game-detail-name">
                    {selectedPlugin.name}
                  </div>
                  {selectedPlugin.version && (
                    <span className="plugins-game-version">
                      v{selectedPlugin.version}
                    </span>
                  )}
                </div>
                <Button
                  ref={toggleControl.ref}
                  variant="ghost"
                  size="sm"
                  type="button"
                  className={`plugins-game-toggle ${
                    selectedPlugin.enabled ? "is-on" : "is-off"
                  }`}
                  onClick={() =>
                    void onTogglePlugin(
                      selectedPlugin.id,
                      !selectedPlugin.enabled,
                    )
                  }
                  disabled={togglingPlugins.has(selectedPlugin.id)}
                  aria-current={selectedPlugin.enabled ? "true" : undefined}
                  {...toggleControl.agentProps}
                >
                  {selectedPlugin.enabled ? t("common.on") : t("common.off")}
                </Button>
              </div>
            </div>
            {selectedPlugin.description && (
              <div
                className="plugins-game-detail-description line-clamp-2"
                title={selectedPlugin.description}
              >
                {selectedPlugin.description}
              </div>
            )}
            {(selectedPlugin.tags?.length ?? 0) > 0 && (
              <div className="flex flex-wrap gap-1.5 px-3 pb-3">
                {selectedPlugin.tags?.map((tag) => (
                  <span
                    key={`${selectedPlugin.id}:${tag}`}
                    className="text-2xs px-1.5 py-px border border-border bg-black/10 text-muted lowercase tracking-wide whitespace-nowrap"
                  >
                    {tag}
                  </span>
                ))}
              </div>
            )}
            {selectedPluginLinks.length > 0 && (
              <div className="plugins-game-detail-links flex flex-wrap gap-2 px-3 pb-3">
                {selectedPluginLinks.map((link) => (
                  <PluginGameResourceLink
                    key={`${selectedPlugin.id}:${link.key}`}
                    pluginId={selectedPlugin.id}
                    linkKey={link.key}
                    url={link.url}
                    label={pluginResourceLinkLabel(t, link.key)}
                    onOpen={onOpenExternalUrl}
                  />
                ))}
              </div>
            )}
            {selectedPlugin.parameters &&
              selectedPlugin.parameters.length > 0 && (
                <div className="plugins-game-detail-config">
                  {selectedPlugin.parameters.map((param: PluginParamDef) => (
                    <PluginGameParamField
                      key={param.key}
                      pluginId={selectedPlugin.id}
                      param={param}
                      value={
                        pluginConfigs[selectedPlugin.id]?.[param.key] ??
                        param.currentValue ??
                        ""
                      }
                      onParamChange={onParamChange}
                    />
                  ))}
                </div>
              )}
            <div className="plugins-game-detail-actions">
              <Button
                ref={testControl.ref}
                variant="outline"
                size="sm"
                type="button"
                className="plugins-game-action-btn"
                onClick={() => void onTestConnection(selectedPlugin.id)}
                {...testControl.agentProps}
              >
                {t("pluginsview.TestConnection")}
              </Button>
              <Button
                ref={saveControl.ref}
                variant="default"
                size="sm"
                type="button"
                className={`plugins-game-action-btn plugins-game-save-btn${
                  pluginSaveSuccess.has(selectedPlugin.id) ? " is-saved" : ""
                }`}
                onClick={() => void onConfigSave(selectedPlugin.id)}
                disabled={pluginSaving.has(selectedPlugin.id)}
                {...saveControl.agentProps}
              >
                {pluginSaving.has(selectedPlugin.id)
                  ? savingLabel
                  : pluginSaveSuccess.has(selectedPlugin.id)
                    ? savedLabel
                    : saveLabel}
              </Button>
            </div>
          </>
        ) : (
          <div className="plugins-game-detail-empty">
            <span className="plugins-game-detail-empty-icon">
              <Puzzle className="h-5 w-5" />
            </span>
            <span className="plugins-game-detail-empty-text">
              {t("pluginsview.SelectA")}{" "}
              {isConnectorLikeMode ? "connector" : "plugin"}{" "}
              {t("pluginsview.toC")}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
