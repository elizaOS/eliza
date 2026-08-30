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
import { Alert } from "../ui/alert";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Card } from "../ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { StatusDot } from "../ui/status-badge";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
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
  "json",
  "code",
  "array",
  "keyvalue",
]);

const MULTILINE_DIALOG_TYPES = new Set([
  "textarea",
  "json",
  "code",
  "array",
  "keyvalue",
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
  const usesMultilineDialog = MULTILINE_DIALOG_TYPES.has(renderProps.fieldType);

  const renderFn =
    renderer ??
    defaultRenderers[renderProps.fieldType] ??
    defaultRenderers.text;

  const [editOpen, setEditOpen] = useState(false);
  const [clearConfirming, setClearConfirming] = useState(false);
  const [draft, setDraft] = useState(() => draftFromProps(renderProps));

  useEffect(() => {
    if (editOpen) setDraft(draftFromProps(renderProps));
  }, [editOpen, renderProps]);

  const chipLabel = useMemo(
    () => displayValue(renderProps, t),
    [renderProps, t],
  );
  const isSensitiveEdit =
    renderProps.hint.sensitive || renderProps.fieldType === "password";
  const canSaveDraft = !isSensitiveEdit || draft.trim().length > 0;
  const canClearSecret =
    isSensitiveEdit && renderProps.isSet && !renderProps.required;

  const statusBadges = (
    <>
      {renderProps.required && !renderProps.isSet ? (
        <Badge variant="requiredStatus" size="micro" className="shrink-0">
          {t("secretsview.Required")}
        </Badge>
      ) : null}
      {renderProps.isSet && layout === "stacked" ? (
        <span className="inline-flex shrink-0 items-center gap-1 text-2xs font-medium text-ok">
          <StatusDot tone="success" className="size-1.5" />
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
      <Card asChild variant="configRow">
        <div
          id={fieldId}
          className={cn(
            "group/field px-4 py-3.5",
            renderProps.readonly && "pointer-events-none",
          )}
        >
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
                  <Button
                    type="button"
                    variant="choice"
                    size="compact"
                    align="start"
                    disabled={renderProps.readonly}
                    onClick={() => {
                      setClearConfirming(false);
                      setEditOpen(true);
                    }}
                    className="max-w-[14rem]"
                    aria-label={t("config-field.editLabel", {
                      defaultValue: "Edit {{label}}",
                      label,
                    })}
                    data-testid={`config-field-edit-${renderProps.key}`}
                  >
                    <span className="min-w-0 truncate">{chipLabel}</span>
                    <Pencil
                      className="size-3 shrink-0 text-muted"
                      aria-hidden
                    />
                  </Button>

                  <Dialog
                    open={editOpen}
                    onOpenChange={(open) => {
                      setEditOpen(open);
                      if (!open) setClearConfirming(false);
                    }}
                  >
                    <DialogContent
                      variant="card"
                      className="max-w-md gap-4 sm:max-w-md"
                    >
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
                        {usesMultilineDialog ? (
                          <Textarea
                            id={`${fieldId}-edit`}
                            value={draft}
                            autoFocus
                            rows={8}
                            placeholder={
                              renderProps.hint.placeholder ||
                              t("config-field.enterValue", {
                                defaultValue: "Enter a value",
                              })
                            }
                            onChange={(event) => setDraft(event.target.value)}
                            variant="configDialog"
                            density="dialogEditor"
                          />
                        ) : (
                          <Input
                            variant="config"
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
                              if (event.key !== "Enter") return;
                              event.preventDefault();
                              if (!canSaveDraft) return;
                              renderProps.onChange(draft);
                              setEditOpen(false);
                            }}
                          />
                        )}
                      </div>

                      {clearConfirming ? (
                        <Alert
                          variant="dangerConfirm"
                          className="px-3 py-2 text-xs"
                        >
                          {t("config-field.clearConfirmation", {
                            defaultValue:
                              "Remove {{label}}? The removal is applied when you save changes.",
                            label,
                          })}
                        </Alert>
                      ) : null}

                      <DialogFooter className="gap-2 sm:gap-2">
                        {clearConfirming ? (
                          <>
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              onClick={() => setClearConfirming(false)}
                            >
                              {t("config-field.keepValue", {
                                defaultValue: "Keep value",
                              })}
                            </Button>
                            <Button
                              type="button"
                              variant="destructive"
                              size="sm"
                              onClick={() => {
                                renderProps.onChange("");
                                setClearConfirming(false);
                                setEditOpen(false);
                              }}
                            >
                              {t("config-field.clearValue", {
                                defaultValue: "Clear value",
                              })}
                            </Button>
                          </>
                        ) : (
                          <>
                            {canClearSecret ? (
                              <Button
                                type="button"
                                variant="surfaceDestructive"
                                size="sm"
                                className="mr-auto"
                                onClick={() => setClearConfirming(true)}
                              >
                                {t("common.clear", { defaultValue: "Clear" })}
                              </Button>
                            ) : null}
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              onClick={() => setEditOpen(false)}
                            >
                              {t("common.cancel", { defaultValue: "Cancel" })}
                            </Button>
                            <Button
                              type="button"
                              variant="default"
                              size="sm"
                              disabled={!canSaveDraft}
                              onClick={() => {
                                if (!canSaveDraft) return;
                                renderProps.onChange(draft);
                                setEditOpen(false);
                              }}
                            >
                              {t("common.save", { defaultValue: "Save" })}
                            </Button>
                          </>
                        )}
                      </DialogFooter>
                    </DialogContent>
                  </Dialog>
                </>
              ) : (
                <div className="w-[min(100%,16rem)]">
                  {renderFn(renderProps)}
                </div>
              )}
            </div>
          </div>
        </div>
      </Card>
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
      }`}
    >
      <div>
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
