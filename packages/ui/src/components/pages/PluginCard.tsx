/**
 * One row/tile in `PluginsView`: shows a plugin's visual, name, and description,
 * an enable/disable toggle (agent-controllable via `useAgentElement`), an
 * expandable settings section (`PluginConfigForm`), and drag handles for
 * reordering. Pure presentation — all state and mutation callbacks are owned by
 * `PluginsView` and passed in as props.
 */
import { memo } from "react";
import { useAgentElement } from "../../agent-surface";
import type { PluginInfo, PluginParamDef } from "../../api";
import { useAppSelector } from "../../state";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { PluginVisual } from "./PluginVisual";

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

export const PluginCard = memo(function PluginCard({
  plugin: p,
  allowCustomOrder,
  pluginSettingsOpen,
  togglingPlugins,
  hasPluginToggleInFlight,
  draggingId,
  dragOverId,
  pluginDescriptionFallback,
  onToggle,
  onToggleSettings,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
  loadFailedLabel,
  notInstalledLabel,
}: PluginCardProps) {
  const t = useAppSelector((s) => s.t);

  const toggleControl = useAgentElement<HTMLButtonElement>({
    id: `plugin-card-${p.id}-toggle`,
    role: "toggle",
    label: `Toggle ${p.name}`,
    group: "plugin-card",
    status: p.enabled ? "active" : "inactive",
    description: `Enable or disable the ${p.name} plugin`,
    onActivate: () => void onToggle(p.id, !p.enabled),
  });

  const hasParams = p.parameters && p.parameters.length > 0;
  const isOpen = pluginSettingsOpen.has(p.id);
  const requiredParams = hasParams
    ? p.parameters.filter((param: PluginParamDef) => param.required)
    : [];
  const requiredSetCount = requiredParams.filter(
    (param: PluginParamDef) => param.isSet,
  ).length;
  const allParamsSet =
    !hasParams ||
    requiredParams.length === 0 ||
    requiredSetCount === requiredParams.length;
  const isShowcase = p.id === "__ui-showcase__";
  const notLoadedLabel = t("pluginsview.NotLoaded", {
    defaultValue: "Not loaded",
  });
  const inactiveLabel = p.loadError
    ? loadFailedLabel
    : p.source === "store"
      ? notInstalledLabel
      : notLoadedLabel;

  const isToggleBusy = togglingPlugins.has(p.id);
  const toggleDisabled =
    isToggleBusy || (hasPluginToggleInFlight && !isToggleBusy);

  const isDragging = draggingId === p.id;
  const isDragOver = dragOverId === p.id && draggingId !== p.id;

  const needsConfig = hasParams && !allParamsSet && !isShowcase;
  const openDetail = () => {
    if (hasParams) onToggleSettings(p.id);
  };

  // Collapse load/config/restart state into the single toggle control: its
  // color is the one health signal. ok (green) = enabled + live; attention
  // (orange) = enabled but waiting on config/restart/activation; error (red) =
  // load failure; neutral = off.
  const toggleHealth: "ok" | "attention" | "error" | "off" = !p.enabled
    ? "off"
    : p.loadError
      ? "error"
      : needsConfig || !p.isActive
        ? "attention"
        : "ok";
  const toggleTitle =
    toggleHealth === "error"
      ? p.loadError || inactiveLabel
      : toggleHealth === "attention"
        ? needsConfig
          ? t("pluginsview.NeedsConfig", {
              defaultValue: "Needs configuration",
            })
          : p.enabled
            ? inactiveLabel
            : undefined
        : undefined;

  return (
    <Button
      asChild
      variant="selection"
      size="row"
      align="start"
      data-state={isOpen ? "on" : "off"}
      data-drag-over={isDragOver ? "true" : undefined}
      role={hasParams ? "button" : undefined}
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
      className={`group relative ${isDragging ? "opacity-30" : ""}`}
    >
      <li
        key={p.id}
        draggable={allowCustomOrder}
        onDragStart={
          allowCustomOrder && onDragStart
            ? (e) => onDragStart(e, p.id)
            : undefined
        }
        onDragOver={
          allowCustomOrder && onDragOver
            ? (e) => onDragOver(e, p.id)
            : undefined
        }
        onDrop={allowCustomOrder && onDrop ? (e) => onDrop(e, p.id) : undefined}
        onDragEnd={allowCustomOrder ? onDragEnd : undefined}
        data-plugin-id={p.id}
      >
        <PluginVisual plugin={p} />
        <div className="min-w-0 flex-1">
          <span className="block truncate text-sm font-bold leading-tight text-txt">
            {p.name}
          </span>
          <p className="line-clamp-1 text-xs text-muted">
            {p.description || pluginDescriptionFallback}
          </p>
        </div>
        {isShowcase ? (
          <Badge variant="metaAccent" size="compact" className="shrink-0">
            {t("pluginsview.DEMO")}
          </Badge>
        ) : (
          <Switch
            ref={toggleControl.ref}
            checked={p.enabled}
            data-plugin-toggle={p.id}
            className="shrink-0"
            title={toggleTitle}
            aria-label={`${p.enabled ? t("common.off") : t("common.on")} ${p.name}`}
            onClick={(e) => {
              e.stopPropagation();
            }}
            onCheckedChange={(enabled) => void onToggle(p.id, enabled)}
            disabled={toggleDisabled}
            {...toggleControl.agentProps}
          />
        )}

        {p.enabled && p.validationErrors && p.validationErrors.length > 0 && (
          <div className="absolute inset-x-3 -bottom-1 text-2xs text-destructive">
            {p.validationErrors.map(
              (err: { field: string; message: string }) => (
                <div key={`${err.field}:${err.message}`} className="truncate">
                  {err.field}: {err.message}
                </div>
              ),
            )}
          </div>
        )}
      </li>
    </Button>
  );
});
