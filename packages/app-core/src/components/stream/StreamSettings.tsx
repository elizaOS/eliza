/**
 * StreamSettings — in-stream settings panel.
 *
 * Panels:
 *   1. Channel / destination picker
 *   2. Overlay widget manager (enable/disable + per-widget config)
 *   3. Stream source selector (stream-tab, game, custom-url)
 */

import { useApp } from "@elizaos/app-core/state";
import { Button, Checkbox, Input, Switch } from "@elizaos/ui";
import { useState } from "react";
import type { StreamSourceType } from "./helpers";
import { isSupportedStreamUrl, STREAM_SOURCE_LABELS } from "./helpers";
import { getAllWidgets } from "./overlays/registry";
import type { WidgetConfigField, WidgetInstance } from "./overlays/types";
import type { UseOverlayLayout } from "./overlays/useOverlayLayout";

type Section = "channel" | "overlays" | "source";

interface StreamSettingsProps {
  destinations: Array<{ id: string; name: string }>;
  activeDestination: { id: string; name: string } | null;
  onDestinationChange: (id: string) => void;
  streamLive: boolean;
  streamSource: { type: StreamSourceType; url?: string };
  activeGameViewerUrl: string;
  onSourceChange: (sourceType: StreamSourceType, customUrl?: string) => void;
  overlayLayout: UseOverlayLayout;
  onClose: () => void;
}

// ---------------------------------------------------------------------------
// Config field renderer
// ---------------------------------------------------------------------------

function ConfigField({
  fieldKey,
  field,
  value,
  onChange,
}: {
  fieldKey: string;
  field: WidgetConfigField;
  value: unknown;
  onChange: (key: string, value: unknown) => void;
}) {
  switch (field.type) {
    case "boolean":
      return (
        <label
          key={fieldKey}
          htmlFor={`config-${fieldKey}`}
          className="flex items-center gap-2 text-[12px] text-txt cursor-pointer"
        >
          <Checkbox
            id={`config-${fieldKey}`}
            checked={Boolean(value)}
            onCheckedChange={(checked) => onChange(fieldKey, !!checked)}
          />
          {field.label}
        </label>
      );
    case "number":
      return (
        <label
          key={fieldKey}
          htmlFor={`config-${fieldKey}`}
          className="flex flex-col gap-0.5"
        >
          <span className="text-[11px] text-muted">{field.label}</span>
          <Input
            id={`config-${fieldKey}`}
            type="number"
            min={field.min}
            max={field.max}
            value={
              typeof value === "number" ? value : (field.default as number)
            }
            onChange={(e) => onChange(fieldKey, Number(e.target.value))}
            className="h-8 bg-bg-muted border-border text-xs rounded px-2"
          />
        </label>
      );
    case "select":
      return (
        <label
          key={fieldKey}
          htmlFor={`config-${fieldKey}`}
          className="flex flex-col gap-0.5"
        >
          <span className="text-[11px] text-muted">{field.label}</span>
          <select
            id={`config-${fieldKey}`}
            value={typeof value === "string" ? value : String(field.default)}
            onChange={(e) => onChange(fieldKey, e.target.value)}
            className="bg-bg-muted border border-border text-txt text-[12px] rounded px-2 py-1 cursor-pointer"
          >
            {field.options?.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </label>
      );
    case "color":
      return (
        <label
          key={fieldKey}
          htmlFor={`config-${fieldKey}`}
          className="flex items-center gap-2"
        >
          <span className="text-[11px] text-muted">{field.label}</span>
          <input
            id={`config-${fieldKey}`}
            type="color"
            value={typeof value === "string" ? value : String(field.default)}
            onChange={(e) => onChange(fieldKey, e.target.value)}
            className="w-8 h-6 rounded border border-border cursor-pointer bg-transparent"
          />
        </label>
      );
    default:
      return (
        <label
          key={fieldKey}
          htmlFor={`config-${fieldKey}`}
          className="flex flex-col gap-0.5"
        >
          <span className="text-[11px] text-muted">{field.label}</span>
          <Input
            id={`config-${fieldKey}`}
            type="text"
            value={
              typeof value === "string" ? value : String(field.default ?? "")
            }
            onChange={(e) => onChange(fieldKey, e.target.value)}
            className="h-8 bg-bg-muted border-border text-xs rounded px-2"
          />
        </label>
      );
  }
}

// ---------------------------------------------------------------------------
// Widget row
// ---------------------------------------------------------------------------

function WidgetRow({
  instance,
  onToggle,
  onUpdate,
}: {
  instance: WidgetInstance;
  onToggle: () => void;
  onUpdate: (patch: Partial<Pick<WidgetInstance, "config">>) => void;
}) {
  const { t } = useApp();
  const [expanded, setExpanded] = useState(false);
  const def = getAllWidgets().find((d) => d.type === instance.type);
  const hasConfig = def && Object.keys(def.configSchema).length > 0;

  return (
    <div className="border border-border rounded-lg overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-2 bg-[rgba(255,255,255,0.03)]">
        {/* Toggle */}
        <Switch
          checked={instance.enabled}
          onCheckedChange={onToggle}
          title={
            instance.enabled
              ? t("streamsettings.DisableWidget")
              : t("streamsettings.EnableWidget")
          }
        />

        <div className="flex-1 min-w-0">
          <div className="text-[12px] font-medium text-txt truncate">
            {def?.name ?? instance.type}
          </div>
          {def?.description && (
            <div className="text-[10px] text-muted truncate">
              {def.description}
            </div>
          )}
        </div>

        {hasConfig && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setExpanded((x) => !x)}
            className="text-muted hover:text-txt text-[10px] h-6 px-1.5 py-0 bg-bg-muted"
          >
            {expanded
              ? t("streamsettings.ConfigExpanded")
              : t("streamsettings.ConfigCollapsed")}
          </Button>
        )}
      </div>

      {expanded && hasConfig && def && (
        <div className="px-3 py-2 border-t border-border flex flex-col gap-2">
          {Object.entries(def.configSchema).map(([key, field]) => (
            <ConfigField
              key={key}
              fieldKey={key}
              field={field}
              value={instance.config[key] ?? field.default}
              onChange={(k, v) =>
                onUpdate({ config: { ...instance.config, [k]: v } })
              }
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main panel
// ---------------------------------------------------------------------------

export function StreamSettings({
  destinations,
  activeDestination,
  onDestinationChange,
  streamLive,
  streamSource,
  activeGameViewerUrl,
  onSourceChange,
  overlayLayout,
  onClose,
}: StreamSettingsProps) {
  const { t } = useApp();
  const [section, setSection] = useState<Section>("channel");
  const [customUrlInput, setCustomUrlInput] = useState(
    streamSource.type === "custom-url" ? (streamSource.url ?? "") : "",
  );
  const trimmedCustomUrl = customUrlInput.trim();
  const customUrlValid = isSupportedStreamUrl(trimmedCustomUrl);

  const { layout, toggleWidget, updateWidget, resetLayout } = overlayLayout;

  const navBtn = (id: Section, label: string) => (
    <Button
      variant={section === id ? "default" : "ghost"}
      size="sm"
      onClick={() => setSection(id)}
      className={`px-3 py-1.5 text-[12px] font-medium rounded-lg transition-colors h-auto ${
        section === id
          ? "bg-accent/20 text-txt hover:bg-accent/30"
          : "text-muted hover:text-txt hover:bg-bg-muted"
      }`}
    >
      {label}
    </Button>
  );

  return (
    <div
      className="absolute inset-0 z-50 flex items-end justify-center"
      style={{ background: "rgba(0,0,0,0.6)", backdropFilter: "blur(4px)" }}
    >
      <div
        className="w-full max-w-xl rounded-t-2xl border border-border overflow-hidden flex flex-col"
        style={{ background: "rgba(14,18,28,0.97)", maxHeight: "80vh" }}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border flex-shrink-0">
          <span className="text-[13px] font-semibold text-txt">
            {t("streamsettings.StreamSettings")}
          </span>
          <Button
            variant="ghost"
            size="sm"
            onClick={onClose}
            className="text-muted hover:text-txt transition-colors text-lg leading-none p-1 h-auto"
          >
            ×
          </Button>
        </div>

        {/* Nav */}
        <div className="flex gap-1 px-4 py-2 border-b border-border flex-shrink-0">
          {navBtn("channel", t("streamsettings.NavChannel"))}
          {navBtn("overlays", t("streamsettings.NavOverlays"))}
          {navBtn("source", t("streamsettings.NavSource"))}
        </div>

        {/* Content */}
        <div className="overflow-y-auto flex-1 px-4 py-4">
          {/* ── Channel / destination ─────────────────────────────── */}
          {section === "channel" && (
            <div className="flex flex-col gap-3">
              <p className="text-[12px] text-muted">
                {t("streamsettings.SelectWhereToBroa")}
              </p>

              {destinations.length === 0 ? (
                <div className="text-[12px] text-muted border border-border rounded-lg p-4 text-center">
                  {t("streamsettings.NoStreamingDestina")}
                  <br />

                  {t("streamsettings.InstallAStreaming")}
                </div>
              ) : (
                <div className="flex flex-col gap-2">
                  {destinations.map((d) => {
                    const active = d.id === activeDestination?.id;
                    return (
                      <Button
                        key={d.id}
                        disabled={streamLive}
                        variant="outline"
                        title={
                          streamLive
                            ? t("streamsettings.StopStreamToChangeChannel")
                            : undefined
                        }
                        onClick={() => onDestinationChange(d.id)}
                        className={`w-full flex items-center justify-start gap-3 px-4 py-3 h-auto rounded-lg border transition-colors disabled:opacity-50 text-left ${
                          active
                            ? "border-accent/60 bg-accent/10"
                            : "border-border bg-white/[0.03] hover:border-accent/30 hover:bg-white/[0.05]"
                        }`}
                      >
                        <span
                          className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${
                            active
                              ? "bg-accent shadow-[0_0_6px_theme(colors.accent.DEFAULT)]"
                              : "bg-muted/30"
                          }`}
                        />
                        <span
                          className={`text-[13px] font-medium ${active ? "text-txt" : "text-txt"}`}
                        >
                          {d.name}
                        </span>
                        {active && (
                          <span className="ml-auto text-[10px] text-txt font-semibold uppercase tracking-wide">
                            {t("appsview.Active")}
                          </span>
                        )}
                      </Button>
                    );
                  })}
                </div>
              )}

              {streamLive && (
                <p className="text-[11px] text-[#f59e0b] border border-[#f59e0b]/30 rounded px-3 py-1.5 bg-[#f59e0b]/5">
                  {t("streamsettings.StreamIsLiveSt")}
                </p>
              )}
            </div>
          )}

          {/* ── Overlay widgets ────────────────────────────────────── */}
          {section === "overlays" && (
            <div className="flex flex-col gap-3">
              <div className="flex items-center justify-between">
                <p className="text-[12px] text-muted">
                  {t("streamsettings.ToggleAndConfigure")}
                </p>
                <Button
                  variant="link"
                  size="sm"
                  onClick={resetLayout}
                  className="text-[11px] text-muted hover:text-danger transition-colors p-0 h-auto"
                >
                  {t("streamsettings.ResetDefaults")}
                </Button>
              </div>

              {layout.widgets.length === 0 ? (
                <div className="text-[12px] text-muted border border-border rounded-lg p-4 text-center">
                  {t("streamsettings.NoWidgetsAvailable")}
                </div>
              ) : (
                <div className="flex flex-col gap-2">
                  {layout.widgets.map((instance) => (
                    <WidgetRow
                      key={instance.id}
                      instance={instance}
                      onToggle={() => toggleWidget(instance.id)}
                      onUpdate={(patch) => updateWidget(instance.id, patch)}
                    />
                  ))}
                </div>
              )}
            </div>
          )}

          {/* ── Stream source ──────────────────────────────────────── */}
          {section === "source" && (
            <div className="flex flex-col gap-3">
              <p className="text-[12px] text-muted">
                {t("streamsettings.ChooseWhatContent")}
              </p>

              {(["stream-tab", "game", "custom-url"] as StreamSourceType[]).map(
                (st) => {
                  const isGame = st === "game";
                  const disabled = isGame && !activeGameViewerUrl.trim();
                  const active = streamSource.type === st;

                  return (
                    <div key={st}>
                      <Button
                        variant="outline"
                        disabled={disabled}
                        onClick={() => {
                          if (st !== "custom-url") {
                            onSourceChange(
                              st,
                              isGame ? activeGameViewerUrl : undefined,
                            );
                          }
                        }}
                        className={`w-full h-auto flex items-center justify-start gap-3 px-4 py-3 rounded-lg border transition-colors text-left ${
                          active && st !== "custom-url"
                            ? "border-accent/60 bg-accent/10"
                            : "border-border bg-white/[0.03] hover:border-accent/30 hover:bg-white/[0.05]"
                        }`}
                      >
                        <span
                          className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${
                            active && st !== "custom-url"
                              ? "bg-accent"
                              : "bg-muted/30"
                          }`}
                        />
                        <div>
                          <div
                            className={`text-[13px] font-medium ${active && st !== "custom-url" ? "text-txt" : "text-txt"}`}
                          >
                            {STREAM_SOURCE_LABELS[st]}
                          </div>
                          <div className="text-[10px] text-muted mt-1.5">
                            {st === "stream-tab" &&
                              t("streamsettings.CaptureStreamBrowserTab")}
                            {st === "game" &&
                              (activeGameViewerUrl.trim()
                                ? `${t("streamsettings.ActiveGame")} ${activeGameViewerUrl}`
                                : t("streamsettings.NoGameActive"))}
                            {st === "custom-url" &&
                              t("streamsettings.BroadcastFromCustomUrl")}
                          </div>
                        </div>
                      </Button>

                      {st === "custom-url" && (
                        <div
                          className={`mt-1 flex items-center gap-2 px-3 py-1.5 rounded-lg border transition-colors ${
                            active
                              ? "border-accent/60 bg-accent/10"
                              : "border-border bg-white/[0.03]"
                          }`}
                        >
                          <Input
                            placeholder={t("streamsettings.httpsYourUrlCom")}
                            value={customUrlInput}
                            onChange={(e) => setCustomUrlInput(e.target.value)}
                            className="flex-1 bg-transparent border-none p-0 h-auto text-xs focus-visible:ring-0 shadow-none placeholder:text-muted/40"
                            onKeyDown={(e) => {
                              if (e.key === "Enter" && customUrlValid) {
                                onSourceChange("custom-url", trimmedCustomUrl);
                              }
                            }}
                          />
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={!customUrlValid}
                            onClick={() => {
                              if (customUrlValid) {
                                onSourceChange("custom-url", trimmedCustomUrl);
                              }
                            }}
                            className="px-2 py-1 h-auto bg-accent/20 text-txt text-[11px] font-semibold hover:bg-accent/30 transition-colors"
                          >
                            {t("streamsettings.Use")}
                          </Button>
                        </div>
                      )}
                      {st === "custom-url" &&
                        trimmedCustomUrl &&
                        !customUrlValid && (
                          <p className="mt-1 px-1 text-[10px] text-danger">
                            {t("streamsettings.CustomURLsMustSta")}
                          </p>
                        )}
                    </div>
                  );
                },
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
