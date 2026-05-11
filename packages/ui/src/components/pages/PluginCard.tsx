import { Button } from "@elizaos/ui";
import type { PluginInfo, PluginParamDef } from "../../api";
import { useApp } from "../../state";
import {
  getPluginResourceLinks,
  iconImageSource,
  pluginResourceLinkLabel,
  resolveIcon,
} from "./plugin-list-utils";

export interface PluginCardProps {
  plugin: PluginInfo;
  allowCustomOrder: boolean;
  pluginSettingsOpen: Set<string>;
  togglingPlugins: Set<string>;
  hasPluginToggleInFlight: boolean;
  installingPlugins: Set<string>;
  updatingPlugins: Set<string>;
  uninstallingPlugins: Set<string>;
  installProgress: Map<string, { phase: string; message: string }>;
  releaseStreamSelections: Record<string, "latest" | "beta">;
  draggingId: string | null;
  dragOverId: string | null;
  pluginDescriptionFallback: string;
  onToggle: (pluginId: string, enabled: boolean) => void;
  onToggleSettings: (pluginId: string) => void;
  onInstall: (pluginId: string, npmName: string) => void;
  onUpdate: (pluginId: string, npmName: string) => void;
  onUninstall: (pluginId: string, npmName: string) => void;
  onReleaseStreamChange: (pluginId: string, stream: "latest" | "beta") => void;
  onOpenExternalUrl: (url: string) => void;
  onDragStart?: (e: React.DragEvent, pluginId: string) => void;
  onDragOver?: (e: React.DragEvent, pluginId: string) => void;
  onDrop?: (e: React.DragEvent, pluginId: string) => void;
  onDragEnd?: () => void;
  installProgressLabel: (message?: string) => string;
  installLabel: string;
  loadFailedLabel: string;
  notInstalledLabel: string;
}

function pluginProvenanceLabels(plugin: PluginInfo): {
  originLabel: string | null;
  supportLabel: string | null;
  title: string | undefined;
} {
  const isThirdParty =
    plugin.thirdParty === true || plugin.origin === "third-party";
  const isBuiltIn = plugin.builtIn === true || plugin.origin === "builtin";
  const isFirstParty =
    plugin.firstParty === true || plugin.support === "first-party";
  const isCommunity =
    plugin.support === "community" || (isThirdParty && !isFirstParty);

  return {
    originLabel: isThirdParty ? "third party" : isBuiltIn ? "built in" : null,
    supportLabel: isCommunity
      ? "community"
      : isFirstParty
        ? "first party"
        : null,
    title: isThirdParty
      ? "Community package registered through the plugin registry"
      : isBuiltIn || isFirstParty
        ? "First-party package generated from the elizaOS plugin registry"
        : undefined,
  };
}

export function PluginCard({
  plugin: p,
  allowCustomOrder,
  pluginSettingsOpen,
  togglingPlugins,
  hasPluginToggleInFlight,
  installingPlugins,
  updatingPlugins,
  uninstallingPlugins,
  installProgress,
  releaseStreamSelections,
  draggingId,
  dragOverId,
  pluginDescriptionFallback,
  onToggle,
  onToggleSettings,
  onInstall,
  onUpdate,
  onUninstall,
  onReleaseStreamChange,
  onOpenExternalUrl,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
  installProgressLabel,
  installLabel,
  loadFailedLabel,
  notInstalledLabel,
}: PluginCardProps) {
  const { t } = useApp();

  const hasParams = p.parameters && p.parameters.length > 0;
  const isOpen = pluginSettingsOpen.has(p.id);
  const requiredParams = hasParams
    ? p.parameters.filter((param: PluginParamDef) => param.required)
    : [];
  const requiredSetCount = requiredParams.filter(
    (param: PluginParamDef) => param.isSet,
  ).length;
  const setCount = hasParams
    ? p.parameters.filter((param: PluginParamDef) => param.isSet).length
    : 0;
  const totalCount = hasParams ? p.parameters.length : 0;
  const allParamsSet =
    !hasParams ||
    requiredParams.length === 0 ||
    requiredSetCount === requiredParams.length;
  const isShowcase = p.id === "__ui-showcase__";
  const selectedReleaseStream =
    releaseStreamSelections[p.id] ??
    p.releaseStream ??
    (p.betaVersion ? "beta" : "latest");
  const remoteVersionForSelection =
    selectedReleaseStream === "beta" ? p.betaVersion : p.latestVersion;
  const showReleaseControls = !isShowcase && Boolean(p.npmName);
  const canUpdate = showReleaseControls && Boolean(p.version);
  const canUninstall =
    !isShowcase && p.source === "store" && Boolean(p.npmName);
  const isInstalling = installingPlugins.has(p.id);
  const isUpdating = updatingPlugins.has(p.id);
  const isUninstalling = uninstallingPlugins.has(p.id);
  const categoryLabel = isShowcase
    ? "showcase"
    : p.category === "ai-provider"
      ? "ai provider"
      : p.category;
  const notLoadedLabel = t("pluginsview.NotLoaded", {
    defaultValue: "Not loaded",
  });
  const isStoreInstallMissing =
    p.source === "store" && p.enabled && !p.isActive && Boolean(p.npmName);
  const inactiveLabel = p.loadError
    ? loadFailedLabel
    : p.source === "store"
      ? notInstalledLabel
      : notLoadedLabel;

  const enabledBorder = isShowcase
    ? "border-l-[3px] border-l-accent"
    : p.enabled
      ? !allParamsSet && hasParams
        ? "border-l-[3px] border-l-warn"
        : "border-l-[3px] border-l-accent"
      : "";
  const isToggleBusy = togglingPlugins.has(p.id);
  const toggleDisabled =
    isToggleBusy || (hasPluginToggleInFlight && !isToggleBusy);

  const isDragging = draggingId === p.id;
  const isDragOver = dragOverId === p.id && draggingId !== p.id;
  const pluginLinks = getPluginResourceLinks(p);
  const provenanceLabels = pluginProvenanceLabels(p);

  return (
    <li
      key={p.id}
      draggable={allowCustomOrder}
      onDragStart={
        allowCustomOrder && onDragStart
          ? (e) => onDragStart(e, p.id)
          : undefined
      }
      onDragOver={
        allowCustomOrder && onDragOver ? (e) => onDragOver(e, p.id) : undefined
      }
      onDrop={allowCustomOrder && onDrop ? (e) => onDrop(e, p.id) : undefined}
      onDragEnd={allowCustomOrder ? onDragEnd : undefined}
      className={`border border-border bg-card transition-colors duration-150 flex flex-col ${enabledBorder} ${
        isOpen ? "ring-1 ring-accent" : "hover:border-accent/40"
      } ${isDragging ? "opacity-30" : ""} ${isDragOver ? "ring-2 ring-accent/60" : ""}`}
      data-plugin-id={p.id}
    >
      <div className="flex items-center gap-2 px-3 pt-3 pb-1">
        {allowCustomOrder && (
          <span
            className="text-2xs text-muted opacity-30 hover:opacity-70 cursor-grab active:cursor-grabbing shrink-0 select-none leading-none"
            title={t("pluginsview.DragToReorder")}
          >
            {t("pluginsview.X2807")}
          </span>
        )}
        <span className="font-bold text-sm flex items-center gap-1.5 min-w-0 truncate flex-1">
          {(() => {
            const icon = resolveIcon(p);
            if (!icon) return null;
            if (typeof icon === "string") {
              const imageSrc = iconImageSource(icon);
              return imageSrc ? (
                <img
                  src={imageSrc}
                  alt=""
                  className="w-5 h-5 rounded-sm object-contain"
                  onError={(e) => {
                    (e.currentTarget as HTMLImageElement).style.display =
                      "none";
                  }}
                />
              ) : (
                <span className="text-sm">{icon}</span>
              );
            }
            const IconComponent = icon;
            return <IconComponent className="w-5 h-5" />;
          })()}
          {p.name}
        </span>
        {isShowcase ? (
          <span className="text-2xs font-bold tracking-wider px-2.5 py-[2px] border border-accent text-txt bg-accent-subtle shrink-0">
            {t("pluginsview.DEMO")}
          </span>
        ) : (
          <Button
            variant="outline"
            size="sm"
            data-plugin-toggle={p.id}
            className={`text-2xs font-bold tracking-wider px-2.5 py-[2px] h-auto rounded-none border transition-colors duration-150 shrink-0 ${
              p.enabled
                ? "bg-accent text-accent-fg border-accent"
                : "bg-transparent text-muted border-border hover:text-txt"
            } ${
              toggleDisabled
                ? "opacity-60 cursor-not-allowed"
                : "cursor-pointer"
            }`}
            onClick={(e) => {
              e.stopPropagation();
              void onToggle(p.id, !p.enabled);
            }}
            disabled={toggleDisabled}
          >
            {isToggleBusy
              ? t("pluginsview.Applying", {
                  defaultValue: "Applying",
                })
              : p.enabled
                ? t("common.on")
                : t("common.off")}
          </Button>
        )}
      </div>
      <div className="flex items-center gap-1.5 px-3 pb-1.5">
        <span className="text-2xs px-1.5 py-px border border-border bg-surface text-muted lowercase tracking-wide whitespace-nowrap">
          {categoryLabel}
        </span>
        {p.version && (
          <span className="text-2xs font-mono text-muted opacity-70">
            v{p.version}
          </span>
        )}
        {showReleaseControls && (
          <span className="text-2xs px-1.5 py-px border border-border bg-surface text-muted lowercase tracking-wide whitespace-nowrap">
            {selectedReleaseStream}
          </span>
        )}
        {provenanceLabels.originLabel && (
          <span
            className="text-2xs px-1.5 py-px border border-border bg-card text-muted lowercase tracking-wide whitespace-nowrap"
            title={provenanceLabels.title}
          >
            {provenanceLabels.originLabel}
          </span>
        )}
        {provenanceLabels.supportLabel && (
          <span
            className={`text-2xs px-1.5 py-px border lowercase tracking-wide whitespace-nowrap ${
              provenanceLabels.supportLabel === "community"
                ? "border-warn/50 bg-[rgba(234,179,8,0.06)] text-warn"
                : "border-accent/40 bg-accent-subtle text-txt"
            }`}
            title={provenanceLabels.title}
          >
            {provenanceLabels.supportLabel}
          </span>
        )}
        {p.enabled && !p.isActive && !isShowcase && (
          <span
            className={`text-2xs px-1.5 py-px border lowercase tracking-wide whitespace-nowrap ${
              p.loadError
                ? "border-destructive bg-[rgba(153,27,27,0.04)] text-destructive"
                : "border-warn bg-[rgba(234,179,8,0.06)] text-warn"
            }`}
            title={
              p.loadError || "Plugin is enabled but not loaded in the runtime"
            }
          >
            {inactiveLabel}
          </span>
        )}
        {isToggleBusy && (
          <span className="text-2xs px-1.5 py-px border border-accent bg-accent-subtle text-txt lowercase tracking-wide whitespace-nowrap">
            {t("pluginsview.restarting")}
          </span>
        )}
      </div>
      <p
        className="text-xs text-muted px-3 pb-2 flex-1"
        style={{
          display: "-webkit-box",
          WebkitLineClamp: 3,
          WebkitBoxOrient: "vertical",
          overflow: "hidden",
        }}
      >
        {p.description || pluginDescriptionFallback}
      </p>

      {(p.tags?.length ?? 0) > 0 && (
        <div className="flex flex-wrap gap-1.5 px-3 pb-2">
          {p.tags?.slice(0, 4).map((tag) => (
            <span
              key={`${p.id}:${tag}`}
              className="whitespace-nowrap border border-border/50 bg-bg-accent/80 px-1.5 py-px text-2xs lowercase tracking-wide text-muted-strong"
            >
              {tag}
            </span>
          ))}
        </div>
      )}

      {pluginLinks.length > 0 && (
        <div className="flex flex-wrap gap-2 px-3 pb-2">
          {pluginLinks.map((link) => (
            <Button
              key={`${p.id}:${link.key}`}
              variant="outline"
              size="sm"
              className="h-6 px-2 text-2xs font-bold border-border/40 text-muted hover:text-txt hover:border-accent hover:bg-accent/5 backdrop-blur-sm transition-all"
              onClick={(e) => {
                e.stopPropagation();
                void onOpenExternalUrl(link.url);
              }}
              title={`${pluginResourceLinkLabel(t, link.key)}: ${link.url}`}
            >
              {pluginResourceLinkLabel(t, link.key)}
            </Button>
          ))}
        </div>
      )}
      <div className="mt-auto flex items-center gap-3 bg-card/55 px-4 py-3">
        {hasParams && !isShowcase ? (
          <>
            <span
              className={`inline-block w-2 h-2 rounded-full shadow-[0_0_10px_currentColor] shrink-0 ${
                allParamsSet
                  ? "bg-ok text-ok"
                  : "bg-destructive text-destructive"
              }`}
            />
            <span className="text-xs-tight font-bold tracking-wide text-muted">
              {setCount}/{totalCount} {t("common.configured")}
            </span>
          </>
        ) : !hasParams && !isShowcase ? (
          <span className="text-xs-tight font-bold tracking-wide text-muted/60">
            {t("pluginsview.NoConfigNeeded")}
          </span>
        ) : (
          <span className="text-xs-tight font-bold tracking-wide text-muted/60">
            {t("pluginsview.23FieldDemos")}
          </span>
        )}
        {showReleaseControls && (
          <div className="flex items-center gap-1">
            <Button
              variant={
                selectedReleaseStream === "latest" ? "default" : "outline"
              }
              size="sm"
              className="h-6 px-2 text-2xs font-bold tracking-wide"
              onClick={(e) => {
                e.stopPropagation();
                onReleaseStreamChange(p.id, "latest");
              }}
            >
              main
            </Button>
            <Button
              variant={selectedReleaseStream === "beta" ? "default" : "outline"}
              size="sm"
              className="h-6 px-2 text-2xs font-bold tracking-wide"
              onClick={(e) => {
                e.stopPropagation();
                onReleaseStreamChange(p.id, "beta");
              }}
            >
              beta
            </Button>
          </div>
        )}
        {showReleaseControls && remoteVersionForSelection && (
          <span className="text-2xs font-mono text-muted/70 whitespace-nowrap">
            {selectedReleaseStream}:{remoteVersionForSelection}
          </span>
        )}
        <div className="flex-1" />
        {isStoreInstallMissing && !isShowcase && !p.loadError && (
          <Button
            variant="default"
            size="sm"
            className="h-7 px-3 text-2xs font-bold tracking-wide shadow-sm max-w-[140px] truncate"
            disabled={isInstalling || isUpdating || isUninstalling}
            onClick={(e) => {
              e.stopPropagation();
              onInstall(p.id, p.npmName ?? "");
            }}
          >
            {isInstalling
              ? installProgressLabel(
                  installProgress.get(p.npmName ?? "")?.message,
                )
              : installLabel}
          </Button>
        )}
        {canUpdate && (
          <Button
            variant="outline"
            size="sm"
            className="h-7 px-3 text-2xs font-bold tracking-wide"
            disabled={isInstalling || isUpdating || isUninstalling}
            onClick={(e) => {
              e.stopPropagation();
              onUpdate(p.id, p.npmName ?? "");
            }}
          >
            {isUpdating
              ? t("common.updating", { defaultValue: "Updating..." })
              : t("pluginsview.Update", { defaultValue: "Update" })}
          </Button>
        )}
        {canUninstall && (
          <Button
            variant="outline"
            size="sm"
            className="h-7 px-3 text-2xs font-bold tracking-wide text-destructive border-destructive/40 hover:border-destructive"
            disabled={isInstalling || isUpdating || isUninstalling}
            onClick={(e) => {
              e.stopPropagation();
              onUninstall(p.id, p.npmName ?? "");
            }}
          >
            {isUninstalling
              ? t("pluginsview.Uninstalling", {
                  defaultValue: "Uninstalling...",
                })
              : t("common.uninstall", {
                  defaultValue: "Uninstall",
                })}
          </Button>
        )}
        {hasParams && (
          <Button
            variant="ghost"
            size="sm"
            className={`h-7 px-2.5 text-xs-tight font-bold transition-all flex items-center gap-1.5 ${
              isOpen
                ? "text-txt bg-accent/10 hover:bg-accent/20"
                : "text-muted hover:bg-bg-hover hover:text-txt"
            }`}
            onClick={(e) => {
              e.stopPropagation();
              onToggleSettings(p.id);
            }}
            title={t("nav.settings")}
          >
            <span className="text-sm leading-none">&#9881;</span>
            <span
              className={`inline-block text-2xs transition-transform duration-200 ${isOpen ? "rotate-90" : ""}`}
            >
              &#9654;
            </span>
          </Button>
        )}
      </div>
      {p.enabled && p.validationErrors && p.validationErrors.length > 0 && (
        <div className="px-3 py-1.5 border-t border-destructive bg-[rgba(153,27,27,0.04)] text-xs">
          {p.validationErrors.map((err: { field: string; message: string }) => (
            <div
              key={`${err.field}:${err.message}`}
              className="text-destructive mb-0.5 text-2xs"
            >
              {err.field}: {err.message}
            </div>
          ))}
        </div>
      )}
      {p.enabled && p.validationWarnings && p.validationWarnings.length > 0 && (
        <div className="px-3 py-1">
          {p.validationWarnings.map((w: { field: string; message: string }) => (
            <div key={`${w.field}:${w.message}`} className="text-warn text-2xs">
              {w.message}
            </div>
          ))}
        </div>
      )}
    </li>
  );
}
