import { useAgentElement } from "../../agent-surface";
import type { PluginInfo, PluginParamDef } from "../../api";
import { useApp } from "../../state";
import { getProvenanceFlags, getProvenanceTitle } from "../apps/provenance";
import { Button } from "../ui/button";
import { PluginVisual } from "./PluginVisual";
import {
  getPluginResourceLinks,
  pluginResourceLinkLabel,
} from "./plugin-list-utils";

function PluginCardResourceLink({
  pluginId,
  linkKey,
  url,
  label,
  title,
  onOpen,
}: {
  pluginId: string;
  linkKey: string;
  url: string;
  label: string;
  title: string;
  onOpen: (url: string) => void;
}) {
  const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
    id: `plugin-card-${pluginId}-link-${linkKey}`,
    role: "link",
    label: `${label} (${pluginId})`,
    group: "plugin-card",
    description: title,
    onActivate: () => onOpen(url),
  });
  return (
    <Button
      ref={ref}
      variant="outline"
      size="sm"
      className="h-6 px-2 text-2xs font-bold border-border/40 text-muted hover:text-txt hover:border-accent hover:bg-accent/5 backdrop-blur-sm transition-all"
      onClick={(e) => {
        e.stopPropagation();
        void onOpen(url);
      }}
      title={title}
      {...agentProps}
    >
      {label}
    </Button>
  );
}

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
  const flags = getProvenanceFlags(plugin);
  return {
    originLabel: flags.isThirdParty
      ? "third party"
      : flags.isBuiltIn
        ? "built in"
        : null,
    supportLabel: flags.isCommunity
      ? "community"
      : flags.isFirstParty
        ? "first party"
        : null,
    title: getProvenanceTitle(flags, "package"),
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

  const toggleControl = useAgentElement<HTMLButtonElement>({
    id: `plugin-card-${p.id}-toggle`,
    role: "toggle",
    label: `Toggle ${p.name}`,
    group: "plugin-card",
    status: p.enabled ? "active" : "inactive",
    description: `Enable or disable the ${p.name} plugin`,
    onActivate: () => void onToggle(p.id, !p.enabled),
  });
  const releaseLatestControl = useAgentElement<HTMLButtonElement>({
    id: `plugin-card-${p.id}-release-main`,
    role: "button",
    label: `${p.name} main release stream`,
    group: "plugin-card",
    description: `Select the main release stream for ${p.name}`,
    onActivate: () => onReleaseStreamChange(p.id, "latest"),
  });
  const releaseBetaControl = useAgentElement<HTMLButtonElement>({
    id: `plugin-card-${p.id}-release-beta`,
    role: "button",
    label: `${p.name} beta release stream`,
    group: "plugin-card",
    description: `Select the beta release stream for ${p.name}`,
    onActivate: () => onReleaseStreamChange(p.id, "beta"),
  });
  const installControl = useAgentElement<HTMLButtonElement>({
    id: `plugin-card-${p.id}-install`,
    role: "button",
    label: `Install ${p.name}`,
    group: "plugin-card",
    description: `Install the ${p.name} plugin package`,
    onActivate: () => onInstall(p.id, p.npmName ?? ""),
  });
  const updateControl = useAgentElement<HTMLButtonElement>({
    id: `plugin-card-${p.id}-update`,
    role: "button",
    label: `Update ${p.name}`,
    group: "plugin-card",
    description: `Update the ${p.name} plugin package`,
    onActivate: () => onUpdate(p.id, p.npmName ?? ""),
  });
  const uninstallControl = useAgentElement<HTMLButtonElement>({
    id: `plugin-card-${p.id}-uninstall`,
    role: "button",
    label: `Uninstall ${p.name}`,
    group: "plugin-card",
    description: `Uninstall the ${p.name} plugin package`,
    onActivate: () => onUninstall(p.id, p.npmName ?? ""),
  });
  const settingsControl = useAgentElement<HTMLButtonElement>({
    id: `plugin-card-${p.id}-settings`,
    role: "button",
    label: `${p.name} settings`,
    group: "plugin-card",
    description: `Open the configuration for the ${p.name} plugin`,
    onActivate: () => onToggleSettings(p.id),
  });

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

  const needsConfig = hasParams && !allParamsSet && !isShowcase;
  const openDetail = () => {
    if (hasParams) onToggleSettings(p.id);
  };

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
      onClick={hasParams ? openDetail : undefined}
      onKeyDown={
        hasParams
          ? (e) => {
              if (
                e.target === e.currentTarget &&
                (e.key === "Enter" || e.key === " ")
              ) {
                e.preventDefault();
                openDetail();
              }
            }
          : undefined
      }
      tabIndex={hasParams ? 0 : undefined}
      className={`group relative flex flex-col rounded-lg border border-border bg-card transition-all duration-150 ${
        hasParams ? "cursor-pointer" : ""
      } ${enabledBorder} ${
        isOpen
          ? "ring-1 ring-accent border-accent/50"
          : "hover:border-accent/40 hover:shadow-[0_2px_18px_-8px_rgba(var(--accent-rgb),0.35)]"
      } ${isDragging ? "opacity-30" : ""} ${
        isDragOver ? "ring-2 ring-accent/60" : ""
      }`}
      data-plugin-id={p.id}
    >
      <div className="flex items-start gap-3 px-4 pt-4">
        <PluginVisual plugin={p} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-sm font-bold leading-tight text-txt">
              {p.name}
            </span>
            {p.version && (
              <span className="shrink-0 font-mono text-2xs text-muted/60">
                v{p.version}
              </span>
            )}
          </div>
          <span className="mt-0.5 block text-2xs font-semibold uppercase tracking-wide text-muted/70">
            {categoryLabel}
          </span>
        </div>
        {isShowcase ? (
          <span className="shrink-0 rounded-full border border-accent bg-accent-subtle px-2.5 py-[3px] text-2xs font-bold tracking-wider text-txt">
            {t("pluginsview.DEMO")}
          </span>
        ) : (
          <Button
            ref={toggleControl.ref}
            variant="outline"
            size="sm"
            data-plugin-toggle={p.id}
            className={`h-auto shrink-0 rounded-full border px-3 py-[3px] text-2xs font-bold tracking-wider transition-colors duration-150 ${
              p.enabled
                ? "border-accent bg-accent text-accent-fg hover:bg-accent/90"
                : "border-border bg-transparent text-muted hover:border-accent/50 hover:text-txt"
            } ${
              toggleDisabled
                ? "cursor-not-allowed opacity-60"
                : "cursor-pointer"
            }`}
            onClick={(e) => {
              e.stopPropagation();
              void onToggle(p.id, !p.enabled);
            }}
            disabled={toggleDisabled}
            aria-current={p.enabled ? "true" : undefined}
            {...toggleControl.agentProps}
          >
            {isToggleBusy
              ? t("pluginsview.Applying", { defaultValue: "Applying" })
              : p.enabled
                ? t("common.on")
                : t("common.off")}
          </Button>
        )}
      </div>

      <p className="line-clamp-1 px-4 pt-2 text-xs text-muted">
        {p.description || pluginDescriptionFallback}
      </p>

      <div className="mt-auto flex flex-wrap items-center gap-1.5 px-4 pb-4 pt-3">
        {p.enabled && allParamsSet && !isShowcase && (
          <span className="inline-flex items-center gap-1.5 rounded-full border border-ok/40 bg-ok/10 px-2 py-[2px] text-2xs font-bold tracking-wide text-ok">
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-ok" />
            {t("common.ready", { defaultValue: "Ready" })}
          </span>
        )}
        {needsConfig && (
          <span className="inline-flex items-center gap-1.5 rounded-full border border-warn/45 bg-warn/10 px-2 py-[2px] text-2xs font-bold tracking-wide text-warn">
            {t("pluginsview.NeedsConfigCount", {
              defaultValue: "Needs config {{set}}/{{total}}",
              set: setCount,
              total: totalCount,
            })}
          </span>
        )}
        {!hasParams && !isShowcase && (
          <span className="rounded-full border border-border/50 bg-bg-accent/70 px-2 py-[2px] text-2xs font-semibold tracking-wide text-muted/70">
            {t("pluginsview.NoConfigNeeded")}
          </span>
        )}
        {p.enabled && !p.isActive && !isShowcase && (
          <span
            className={`rounded-full border px-2 py-[2px] text-2xs font-bold tracking-wide ${
              p.loadError
                ? "border-destructive/50 bg-destructive-subtle text-destructive"
                : "border-warn/45 bg-warn/10 text-warn"
            }`}
            title={
              p.loadError || "Plugin is enabled but not loaded in the runtime"
            }
          >
            {inactiveLabel}
          </span>
        )}
        {isToggleBusy && (
          <span className="rounded-full border border-accent/50 bg-accent-subtle px-2 py-[2px] text-2xs font-bold tracking-wide text-txt">
            {t("pluginsview.restarting")}
          </span>
        )}
        {provenanceLabels.supportLabel && (
          <span
            className={`rounded-full border px-2 py-[2px] text-2xs font-semibold tracking-wide ${
              provenanceLabels.supportLabel === "community"
                ? "border-warn/40 bg-warn/10 text-warn"
                : "border-accent/35 bg-accent-subtle text-txt"
            }`}
            title={provenanceLabels.title}
          >
            {provenanceLabels.supportLabel}
          </span>
        )}

        <div className="ml-auto flex items-center gap-1.5">
          {showReleaseControls && (
            <div className="flex items-center gap-0.5">
              <Button
                ref={releaseLatestControl.ref}
                variant={
                  selectedReleaseStream === "latest" ? "default" : "outline"
                }
                size="sm"
                className="h-6 rounded-full px-2 text-2xs font-bold tracking-wide"
                onClick={(e) => {
                  e.stopPropagation();
                  onReleaseStreamChange(p.id, "latest");
                }}
                {...releaseLatestControl.agentProps}
              >
                main
              </Button>
              <Button
                ref={releaseBetaControl.ref}
                variant={
                  selectedReleaseStream === "beta" ? "default" : "outline"
                }
                size="sm"
                className="h-6 rounded-full px-2 text-2xs font-bold tracking-wide"
                onClick={(e) => {
                  e.stopPropagation();
                  onReleaseStreamChange(p.id, "beta");
                }}
                {...releaseBetaControl.agentProps}
              >
                beta
              </Button>
            </div>
          )}
          {isStoreInstallMissing && !isShowcase && !p.loadError && (
            <Button
              ref={installControl.ref}
              variant="default"
              size="sm"
              className="h-7 max-w-[140px] truncate rounded-full px-3 text-2xs font-bold tracking-wide"
              disabled={isInstalling || isUpdating || isUninstalling}
              onClick={(e) => {
                e.stopPropagation();
                onInstall(p.id, p.npmName ?? "");
              }}
              {...installControl.agentProps}
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
              ref={updateControl.ref}
              variant="outline"
              size="sm"
              className="h-7 rounded-full px-3 text-2xs font-bold tracking-wide"
              disabled={isInstalling || isUpdating || isUninstalling}
              onClick={(e) => {
                e.stopPropagation();
                onUpdate(p.id, p.npmName ?? "");
              }}
              {...updateControl.agentProps}
            >
              {isUpdating
                ? t("common.updating", { defaultValue: "Updating..." })
                : t("pluginsview.Update", { defaultValue: "Update" })}
            </Button>
          )}
          {canUninstall && (
            <Button
              ref={uninstallControl.ref}
              variant="outline"
              size="sm"
              className="h-7 rounded-full border-destructive/40 px-3 text-2xs font-bold tracking-wide text-destructive hover:border-destructive"
              disabled={isInstalling || isUpdating || isUninstalling}
              onClick={(e) => {
                e.stopPropagation();
                onUninstall(p.id, p.npmName ?? "");
              }}
              {...uninstallControl.agentProps}
            >
              {isUninstalling
                ? t("pluginsview.Uninstalling", {
                    defaultValue: "Uninstalling...",
                  })
                : t("common.uninstall", { defaultValue: "Uninstall" })}
            </Button>
          )}
          {pluginLinks[0] && (
            <PluginCardResourceLink
              pluginId={p.id}
              linkKey={pluginLinks[0].key}
              url={pluginLinks[0].url}
              label={pluginResourceLinkLabel(t, pluginLinks[0].key)}
              title={`${pluginResourceLinkLabel(t, pluginLinks[0].key)}: ${pluginLinks[0].url}`}
              onOpen={onOpenExternalUrl}
            />
          )}
          {hasParams && (
            <Button
              ref={settingsControl.ref}
              variant="ghost"
              size="sm"
              className={`flex h-7 items-center gap-1 rounded-full px-2.5 text-xs-tight font-bold transition-all ${
                isOpen
                  ? "bg-accent/10 text-txt hover:bg-accent/20"
                  : "text-muted hover:bg-bg-hover hover:text-txt"
              }`}
              onClick={(e) => {
                e.stopPropagation();
                onToggleSettings(p.id);
              }}
              title={t("nav.settings")}
              {...settingsControl.agentProps}
            >
              <span className="text-sm leading-none">&#9881;</span>
            </Button>
          )}
        </div>
      </div>

      {p.enabled && p.validationErrors && p.validationErrors.length > 0 && (
        <div className="border-t border-destructive/50 bg-destructive-subtle px-4 py-1.5 text-2xs">
          {p.validationErrors.map((err: { field: string; message: string }) => (
            <div
              key={`${err.field}:${err.message}`}
              className="mb-0.5 text-destructive"
            >
              {err.field}: {err.message}
            </div>
          ))}
        </div>
      )}
    </li>
  );
}
