/**
 * Renders one plugin configuration field with the standard label, status,
 * renderer, validation, and help-text structure used by config panels.
 *
 * In `row` layout (connector detail), text/number values rest as a trailing
 * chip that opens an edit dialog — matching the Devin settings pattern —
 * while booleans stay an inline switch.
 */
import { Pencil } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type {
  FieldRenderer,
  FieldRenderProps,
} from "../../config/config-catalog";
import { cn } from "../../lib/utils";
import { useAppSelector } from "../../state";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { defaultRenderers } from "./config-field.helpers";

/** Field chrome layout. `row` = one setting per line (label left, control right). */
export type ConfigFieldLayout = "stacked" | "row";

const DIALOG_EDIT_TYPES = new Set([
  "text",
  "password",
  "number",
  "url",
  "email",
  "textarea",
  "string",
]);

function displayValue(
  renderProps: FieldRenderProps,
  t: (key: string, opts?: { defaultValue?: string }) => string,
): string {
  if (renderProps.hint.sensitive || renderProps.fieldType === "password") {
    if (renderProps.isSet || isConfigValueFilled(renderProps.value)) {
      return "••••••••";
    }
    return t("config-field.setValue", { defaultValue: "Set value" });
  }
  if (isConfigValueFilled(renderProps.value)) {
    const raw = Array.isArray(renderProps.value)
      ? renderProps.value.join(", ")
      : String(renderProps.value);
    return raw.length > 28 ? `${raw.slice(0, 26)}…` : raw;
  }
  if (renderProps.isSet) {
    return t("config-field.configured", { defaultValue: "Configured" });
  }
  return t("config-field.setValue", { defaultValue: "Set value" });
}

function isConfigValueFilled(value: unknown): boolean {
  if (value == null) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.length > 0;
  return Boolean(value);
}

function draftFromProps(renderProps: FieldRenderProps): string {
  if (renderProps.hint.sensitive || renderProps.fieldType === "password") {
    // Never echo secrets into the dialog — start empty for replace-on-save.
    return "";
  }
  if (renderProps.value == null) return "";
  if (Array.isArray(renderProps.value)) return renderProps.value.join(", ");
  return String(renderProps.value);
}

/**
 * Wraps a field renderer with the standard label row, env key display,
 * help text, and error messages.
 */
export function ConfigField({
  renderProps,
  renderer,
  pluginId,
  layout = "stacked",
}: {
  renderProps: FieldRenderProps;
  renderer: FieldRenderer;
  pluginId?: string;
  layout?: ConfigFieldLayout;
}) {
  const t = useAppSelector((s) => s.t);
  const label = renderProps.hint.label ?? renderProps.key;
  const errors = renderProps.errors ?? [];
  const hasError = errors.length > 0;
  const isRequiredEmpty = renderProps.required && !renderProps.isSet;
  const helpText = renderProps.hint.help ?? renderProps.schema.description;
  const isBoolean =
    renderProps.fieldType === "boolean" ||
    renderProps.fieldType === "switch" ||
    renderProps.fieldType === "checkbox";
  const usesEditDialog =
    layout === "row" &&
    !isBoolean &&
    (DIALOG_EDIT_TYPES.has(renderProps.fieldType) ||
      renderProps.fieldType === "text" ||
      !renderProps.fieldType);

  const renderFn =
    renderer ??
    defaultRenderers[renderProps.fieldType] ??
    defaultRenderers.text;

  const [editOpen, setEditOpen] = useState(false);
  const [draft, setDraft] = useState(() => draftFromProps(renderProps));

  useEffect(() => {
    if (editOpen) setDraft(draftFromProps(renderProps));
  }, [editOpen, renderProps]);

  const chipLabel = useMemo(
    () => displayValue(renderProps, t),
    [renderProps, t],
  );

  const statusBadges = (
    <>
      {renderProps.required && !renderProps.isSet ? (
        <span className="shrink-0 rounded-sm bg-[color-mix(in_srgb,var(--destructive)_10%,transparent)] px-1.5 py-px text-2xs font-semibold text-destructive">
          {t("secretsview.Required")}
        </span>
      ) : null}
      {renderProps.isSet && layout === "stacked" ? (
        <span className="inline-flex shrink-0 items-center gap-1 text-2xs font-medium text-ok">
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-ok" />
          {t("config-field.Configured")}
        </span>
      ) : null}
    </>
  );

  const errorBlock = hasError ? (
    <div className="mt-1.5 flex flex-col gap-0.5">
      {errors.map((err) => (
        <div
          key={err}
          className="flex items-start gap-1 leading-snug"
          style={{
            fontSize: "var(--plugin-error-size)",
            color: "var(--plugin-error)",
          }}
        >
          <span className="mt-px shrink-0">{t("config-field.Times")}</span>
          <span>{err}</span>
        </div>
      ))}
    </div>
  ) : null;

  const helpBlock = helpText ? (
    <div
      className={cn(
        "leading-relaxed text-muted",
        layout === "row" ? "line-clamp-2 text-xs" : "mt-1 line-clamp-2",
      )}
      style={{
        fontSize: layout === "row" ? undefined : "var(--plugin-help-size)",
        color: "var(--plugin-help)",
      }}
    >
      {helpText}
    </div>
  ) : null;

  if (layout === "row") {
    const fieldId = pluginId
      ? `field-${pluginId}-${renderProps.key}`
      : `field-${renderProps.key}`;

    return (
      <div
        id={fieldId}
        className={cn(
          "group/field border-b border-border/40 px-4 py-3.5 last:border-b-0",
          renderProps.readonly && "pointer-events-none",
          isRequiredEmpty && "relative",
        )}
      >
        {isRequiredEmpty ? (
          <div className="absolute bottom-2 left-0 top-2 w-[2px] rounded-full bg-destructive opacity-40" />
        ) : null}

        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0 flex-1 space-y-0.5">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium leading-snug text-txt-strong">
                {label}
              </span>
              {statusBadges}
            </div>
            {helpBlock}
            {errorBlock}
          </div>

          <div className="shrink-0 pt-0.5">
            {isBoolean ? (
              <Switch
                aria-label={label}
                checked={
                  renderProps.value === true ||
                  renderProps.value === "true" ||
                  renderProps.value === "1" ||
                  (!renderProps.isSet &&
                    (renderProps.schema.default === true ||
                      renderProps.schema.default === "true"))
                }
                disabled={renderProps.readonly}
                onCheckedChange={(next) => {
                  renderProps.onChange(String(next));
                }}
              />
            ) : usesEditDialog ? (
              <>
                <button
                  type="button"
                  disabled={renderProps.readonly}
                  onClick={() => setEditOpen(true)}
                  className={cn(
                    "inline-flex max-w-[14rem] items-center gap-1.5 rounded-md border border-border/70 bg-bg-muted/80 px-2.5 py-1.5 text-left text-xs font-medium text-txt-strong transition-colors",
                    "hover:border-border hover:bg-bg-hover",
                    !isConfigValueFilled(renderProps.value) &&
                      !renderProps.isSet &&
                      "text-muted",
                  )}
                  data-testid={`config-field-edit-${renderProps.key}`}
                >
                  <span className="min-w-0 truncate">{chipLabel}</span>
                  <Pencil className="h-3 w-3 shrink-0 text-muted" aria-hidden />
                </button>

                <Dialog open={editOpen} onOpenChange={setEditOpen}>
                  <DialogContent className="max-w-md gap-4 bg-card sm:max-w-md">
                    <DialogHeader>
                      <DialogTitle>
                        {t("config-field.changeTitle", {
                          defaultValue: "Change {{label}}",
                          label,
                        })}
                      </DialogTitle>
                      <DialogDescription>
                        {helpText ||
                          t("config-field.changeDescription", {
                            defaultValue: "Enter a new value for {{label}}.",
                            label,
                          })}
                      </DialogDescription>
                    </DialogHeader>

                    <div className="space-y-2">
                      <label
                        htmlFor={`${fieldId}-edit`}
                        className="text-sm font-medium text-txt-strong"
                      >
                        {label}
                      </label>
                      <Input
                        id={`${fieldId}-edit`}
                        type={
                          renderProps.fieldType === "password" ||
                          renderProps.hint.sensitive
                            ? "password"
                            : renderProps.fieldType === "number"
                              ? "number"
                              : renderProps.fieldType === "email"
                                ? "email"
                                : renderProps.fieldType === "url"
                                  ? "url"
                                  : "text"
                        }
                        value={draft}
                        autoFocus
                        placeholder={
                          renderProps.hint.placeholder ||
                          (renderProps.hint.sensitive ||
                          renderProps.fieldType === "password"
                            ? t("config-field.secretPlaceholder", {
                                defaultValue: "Enter new value",
                              })
                            : undefined)
                        }
                        onChange={(event) => setDraft(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") {
                            event.preventDefault();
                            renderProps.onChange(draft);
                            setEditOpen(false);
                          }
                        }}
                        className="h-10 border-border/60 bg-bg-muted"
                      />
                    </div>

                    <DialogFooter className="gap-2 sm:gap-2">
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="text-txt"
                        onClick={() => setEditOpen(false)}
                      >
                        {t("common.cancel", { defaultValue: "Cancel" })}
                      </Button>
                      <Button
                        type="button"
                        variant="default"
                        size="sm"
                        onClick={() => {
                          renderProps.onChange(draft);
                          setEditOpen(false);
                        }}
                      >
                        {t("common.save", { defaultValue: "Save" })}
                      </Button>
                    </DialogFooter>
                  </DialogContent>
                </Dialog>
              </>
            ) : (
              <div className="w-[min(100%,16rem)]">{renderFn(renderProps)}</div>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      id={
        pluginId
          ? `field-${pluginId}-${renderProps.key}`
          : `field-${renderProps.key}`
      }
      className={`group/field py-2.5 ${
        renderProps.readonly ? "pointer-events-none" : ""
      } ${isRequiredEmpty ? "relative" : ""}`}
    >
      {isRequiredEmpty && (
        <div className="absolute bottom-2.5 left-0 top-2.5 w-[2px] rounded-full bg-destructive opacity-40" />
      )}

      <div className={isRequiredEmpty ? "pl-2.5" : ""}>
        <div className="mb-1.5 flex items-center gap-2">
          <span
            className="font-semibold leading-tight"
            style={{
              fontSize: "var(--plugin-label-size)",
              color: "var(--plugin-label)",
            }}
          >
            {label}
          </span>
          {statusBadges}
        </div>

        {renderFn(renderProps)}
        {errorBlock}
        {helpBlock ? <div className="mt-1">{helpBlock}</div> : null}
      </div>
    </div>
  );
}
