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
import { Button } from "../ui/button";
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
  const toggleHealthClass =
    toggleHealth === "ok"
      ? "border-ok bg-ok text-white hover:bg-ok/90"
      : toggleHealth === "attention"
        ? "border-accent bg-accent text-accent-fg hover:bg-accent/90"
        : toggleHealth === "error"
          ? "border-destructive bg-destructive text-white hover:bg-destructive/90"
          : "border-border bg-transparent text-muted hover:border-accent/50 hover:text-txt";
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
      className={`group relative flex items-center gap-3 rounded-md px-3 py-2.5 transition-colors duration-150 ${
        hasParams ? "cursor-pointer" : ""
      } ${
        isOpen ? "bg-accent/10" : "hover:bg-bg-hover"
      } ${isDragging ? "opacity-30" : ""} ${isDragOver ? " " : ""}`}
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
        <span className="shrink-0 rounded-full border border-accent bg-accent-subtle px-2.5 py-[3px] text-2xs font-bold tracking-wider text-txt">
          {t("pluginsview.DEMO")}
        </span>
      ) : (
        <Button
          ref={toggleControl.ref}
          variant="outline"
          size="sm"
          data-plugin-toggle={p.id}
          className={`min-h-11 shrink-0 rounded-full border px-3 py-2 text-2xs font-bold tracking-wider transition-colors duration-150 ${toggleHealthClass} ${
            toggleDisabled ? "cursor-not-allowed opacity-60" : "cursor-pointer"
          }`}
          title={toggleTitle}
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

      {p.enabled && p.validationErrors && p.validationErrors.length > 0 && (
        <div className="absolute inset-x-3 -bottom-1 text-2xs text-destructive">
          {p.validationErrors.map((err: { field: string; message: string }) => (
            <div key={`${err.field}:${err.message}`} className="truncate">
              {err.field}: {err.message}
            </div>
          ))}
        </div>
      )}
    </li>
  );
});
