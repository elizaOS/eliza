import type { CSSProperties } from "react";
import type { PluginInfo, PluginParamDef } from "../../api";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import {
  iconImageSource,
  pluginResourceLinkLabel,
  resolveIcon,
  type TranslateFn,
} from "./plugin-list-utils";

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
  if (!icon) return "🧩";
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
      <span className={emojiClassName}>{icon}</span>
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
              <Button
                variant="ghost"
                key={plugin.id}
                type="button"
                role="option"
                aria-selected={effectiveGameSelected === plugin.id}
                className={`plugins-game-card${
                  effectiveGameSelected === plugin.id ? " is-selected" : ""
                }${!plugin.enabled ? " is-disabled" : ""} h-auto`}
                onClick={() => onSelectPlugin(plugin.id)}
              >
                <div className="plugins-game-card-icon-shell">
                  <span className="plugins-game-card-icon">
                    <ResolvedPluginIcon
                      plugin={plugin}
                      imageClassName="plugins-game-card-icon"
                      imageStyle={{ objectFit: "contain" }}
                      iconClassName="w-5 h-5"
                    />
                  </span>
                </div>
                <div className="plugins-game-card-body">
                  <div className="plugins-game-card-name">{plugin.name}</div>
                  <div className="plugins-game-card-meta">
                    <span
                      className={`plugins-game-badge ${
                        plugin.enabled ? "is-on" : "is-off"
                      }`}
                    >
                      {plugin.enabled ? t("common.on") : t("common.off")}
                    </span>
                  </div>
                </div>
              </Button>
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
                  variant="ghost"
                  size="sm"
                  type="button"
                  className="plugins-game-back-btn"
                  onClick={onBack}
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
                >
                  {selectedPlugin.enabled ? t("common.on") : t("common.off")}
                </Button>
              </div>
            </div>
            <div className="plugins-game-detail-description">
              {selectedPlugin.description}
            </div>
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
                  <Button
                    variant="outline"
                    size="sm"
                    key={`${selectedPlugin.id}:${link.key}`}
                    type="button"
                    className="plugins-game-link-btn border border-border bg-transparent px-2.5 py-1 text-xs-tight text-muted transition-colors hover:border-accent hover:text-txt"
                    onClick={() => {
                      void onOpenExternalUrl(link.url);
                    }}
                  >
                    {pluginResourceLinkLabel(t, link.key)}
                  </Button>
                ))}
              </div>
            )}
            {selectedPlugin.parameters &&
              selectedPlugin.parameters.length > 0 && (
                <div className="plugins-game-detail-config">
                  {selectedPlugin.parameters.map((param: PluginParamDef) => (
                    <div key={param.key} id={`field-${param.key}`}>
                      <label
                        htmlFor={`input-${param.key}`}
                        className="text-xs-tight tracking-wider text-muted block mb-1"
                      >
                        {param.key}
                      </label>
                      <Input
                        id={`input-${param.key}`}
                        type={param.sensitive ? "password" : "text"}
                        className="w-full px-2 py-1 text-xs"
                        placeholder={param.description}
                        value={
                          pluginConfigs[selectedPlugin.id]?.[param.key] ??
                          param.currentValue ??
                          ""
                        }
                        onChange={(event) =>
                          onParamChange(
                            selectedPlugin.id,
                            param.key,
                            event.target.value,
                          )
                        }
                      />
                    </div>
                  ))}
                </div>
              )}
            <div className="plugins-game-detail-actions">
              <Button
                variant="outline"
                size="sm"
                type="button"
                className="plugins-game-action-btn"
                onClick={() => void onTestConnection(selectedPlugin.id)}
              >
                {t("pluginsview.TestConnection")}
              </Button>
              <Button
                variant="default"
                size="sm"
                type="button"
                className={`plugins-game-action-btn plugins-game-save-btn${
                  pluginSaveSuccess.has(selectedPlugin.id) ? " is-saved" : ""
                }`}
                onClick={() => void onConfigSave(selectedPlugin.id)}
                disabled={pluginSaving.has(selectedPlugin.id)}
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
            <span className="plugins-game-detail-empty-icon">🧩</span>
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
