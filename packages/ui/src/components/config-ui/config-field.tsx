import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { CONFIG_SELECT_FLOATING_LAYER_NAME, CONFIG_SELECT_FLOATING_LAYER_Z_INDEX } from "../../lib/floating-layers";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { ChevronDown, X } from "lucide-react";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type {
  FieldRenderer,
  FieldRenderProps,
} from "../../config/config-catalog";
import { resolveDynamic } from "../../config/config-catalog";
import { useApp } from "../../state";
import type { DynamicValue } from "../../types";
import {
  getConfigInputClassName,
  getConfigTextareaClassName,
} from "./config-control-primitives";

// ── Action binding helper ──────────────────────────────────────────────

/**
 * Resolve DynamicValue params and fire the onAction callback.
 * No-ops when the binding or onAction is missing.
 */
function fireAction(props: FieldRenderProps, eventName: string): void {
  const binding = props.hint.on?.[eventName];
  if (!binding || !props.onAction) return;

  // Resolve any DynamicValue params against a state snapshot built from the
  // current field value (keyed by the field's own key).  The resolveDynamic
  // function handles both literal values and { path } references.
  let resolvedParams: Record<string, unknown> | undefined;
  if (binding.params) {
    const state: Record<string, unknown> = { [props.key]: props.value };
    resolvedParams = {};
    for (const [k, v] of Object.entries(binding.params)) {
      resolvedParams[k] = resolveDynamic(v as DynamicValue, state);
    }
  }

  void props.onAction(binding.action, resolvedParams);
}

function inputCls(hasError: boolean): string {
  return getConfigInputClassName({ hasError });
}

function textareaCls(hasError: boolean, className?: string): string {
  return getConfigTextareaClassName({ hasError, className });
}

// ── 1. Text ─────────────────────────────────────────────────────────────

/** Single-line text input for unresolved field types. */
export function renderTextField(props: FieldRenderProps) {
  const value = props.isSet ? String(props.value ?? "") : "";
  const placeholder =
    (props.hint.placeholder as string | undefined) ??
    (props.schema.default != null
      ? `Default: ${props.schema.default}`
      : "Enter value...");

  return (
    <input
      className={inputCls(!!props.errors?.length)}
      type="text"
      defaultValue={value}
      placeholder={placeholder}
      data-config-key={props.key}
      data-field-type="text"
      disabled={props.readonly}
      onChange={(e) => {
        props.onChange(e.target.value);
        fireAction(props, "change");
      }}
      onBlur={() => fireAction(props, "blur")}
      onClick={() => fireAction(props, "click")}
    />
  );
}

// ── 2. Password ─────────────────────────────────────────────────────────

/** Masked password input with show/hide toggle and async onReveal for server-backed decryption. */
export function renderPasswordField(props: FieldRenderProps) {
  return <PasswordFieldInner fp={props} />;
}

function PasswordFieldInner({ fp: props }: { fp: FieldRenderProps }) {
  const maskedValue = props.isSet ? String(props.value ?? "") : "";
  const placeholder = props.isSet
    ? `Current: ${maskedValue || "********"}  (leave blank to keep)`
    : ((props.hint.placeholder as string | undefined) ?? "Enter value...");

  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [fieldValue, setFieldValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const onReveal = props.onReveal;

  const handleToggle = useCallback(async () => {
    if (visible) {
      // Hide — just toggle visibility, value stays in React state
      setVisible(false);
      return;
    }

    // Reveal: fetch the real value from the server
    if (onReveal) {
      setBusy(true);
      const realValue = await onReveal();
      setBusy(false);
      if (realValue != null) {
        setVisible(true);
        setFieldValue(realValue);
        props.onChange(realValue);
      }
    } else {
      // Toggle type directly so the current input value stays visible.
      setVisible(true);
    }
  }, [visible, onReveal, props]);

  return (
    <div className="flex">
      <input
        ref={inputRef}
        className="flex-1 px-3 py-2 border border-border border-r-0 bg-card text-sm font-[var(--mono)] transition-all focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent box-border h-9 rounded-l-sm placeholder:text-muted placeholder:opacity-60"
        type={visible ? "text" : "password"}
        value={fieldValue}
        placeholder={placeholder}
        data-config-key={props.key}
        data-field-type="password"
        onChange={(e) => {
          setFieldValue(e.target.value);
          props.onChange(e.target.value);
          fireAction(props, "change");
        }}
        onBlur={() => fireAction(props, "blur")}
      />
      <Button
        type="button"
        variant="outline"
        size="default"
        className="px-3 border border-border bg-bg-hover text-xs-tight text-muted whitespace-nowrap min-w-[56px] text-center transition-colors hover:bg-surface hover:text-txt h-9 font-medium rounded-l-none rounded-r-sm"
        onClick={() => {
          void handleToggle();
          fireAction(props, "click");
        }}
        title={visible ? "Hide value" : "Reveal value"}
      >
        {busy ? "\u2026" : visible ? "\u{1F441} Hide" : "\u{1F441} Show"}
      </Button>
    </div>
  );
}

// ── 3. Number ───────────────────────────────────────────────────────────

/** Numeric input with min/max/step attributes derived from schema and hints. */
export function renderNumberField(props: FieldRenderProps) {
  return <NumberFieldInner fp={props} />;
}

function NumberFieldInner({ fp: props }: { fp: FieldRenderProps }) {
  const minVal =
    props.schema.minimum ?? (props.hint.min as number | undefined) ?? undefined;
  const maxVal =
    props.schema.maximum ?? (props.hint.max as number | undefined) ?? undefined;
  const stepVal = (props.hint.step as number | undefined) ?? 1;
  const unit = props.hint.unit as string | undefined;
  const placeholder =
    (props.hint.placeholder as string | undefined) ??
    (props.schema.default != null
      ? `Default: ${props.schema.default}`
      : "Enter number...");

  const initial = props.isSet ? String(props.value ?? "") : "";
  const [val, setVal] = useState(initial);

  const hasRange = minVal != null || maxVal != null;

  const step = (direction: 1 | -1) => {
    const current = val === "" ? 0 : Number(val);
    if (Number.isNaN(current)) return;
    let next = current + direction * stepVal;
    if (minVal != null && next < minVal) next = minVal;
    if (maxVal != null && next > maxVal) next = maxVal;
    const s = String(next);
    setVal(s);
    props.onChange(s);
    fireAction(props, "change");
  };

  return (
    <div>
      <div className="flex items-center gap-1.5">
        {!props.readonly && (
          <Button
            type="button"
            variant="outline"
            size="default"
            className="px-2 py-1.5 bg-transparent text-sm text-muted transition-colors hover:bg-surface hover:text-txt h-9 rounded-sm font-mono select-none"
            onClick={() => step(-1)}
          >
            −
          </Button>
        )}
        <input
          className={`${inputCls(!!props.errors?.length)} ${unit ? "flex-1" : "w-full"} text-center`}
          type="number"
          value={val}
          placeholder={placeholder}
          min={minVal}
          max={maxVal}
          step={stepVal}
          data-config-key={props.key}
          data-field-type="number"
          disabled={props.readonly}
          onChange={(e) => {
            setVal(e.target.value);
            props.onChange(e.target.value);
            fireAction(props, "change");
          }}
          onBlur={() => fireAction(props, "blur")}
          onClick={() => fireAction(props, "click")}
        />
        {!props.readonly && (
          <Button
            type="button"
            variant="outline"
            size="default"
            className="px-2 py-1.5 bg-transparent text-sm text-muted transition-colors hover:bg-surface hover:text-txt h-9 rounded-sm font-mono select-none"
            onClick={() => step(1)}
          >
            +
          </Button>
        )}
        {unit && (
          <span className="text-xs-tight text-muted font-medium shrink-0 min-w-[20px]">
            {unit}
          </span>
        )}
      </div>
      {hasRange && (
        <div className="text-2xs text-muted mt-0.5 opacity-70">
          {minVal != null && maxVal != null
            ? `Range: ${minVal}–${maxVal}${unit ? ` ${unit}` : ""}`
            : minVal != null
              ? `Min: ${minVal}${unit ? ` ${unit}` : ""}`
              : `Max: ${maxVal}${unit ? ` ${unit}` : ""}`}
        </div>
      )}
    </div>
  );
}

// ── 4. Boolean ──────────────────────────────────────────────────────────

/** Pill-shaped toggle switch. Accepts boolean or string 'true'/'false' values. */
export function renderBooleanField(props: FieldRenderProps) {
  return <BooleanFieldInner fp={props} />;
}

function BooleanFieldInner({ fp: props }: { fp: FieldRenderProps }) {
  const val =
    props.value === true || props.value === "true" || props.value === "1";
  const initialVal = props.isSet
    ? val
    : props.schema.default === true || props.schema.default === "true";

  const [localVal, setLocalVal] = useState(initialVal);

  const handleToggle = () => {
    const next = !localVal;
    setLocalVal(next);
    props.onChange(String(next));
    fireAction(props, "change");
  };

  return (
    <div
      className="flex items-center gap-2.5"
      data-config-key={props.key}
      data-field-type="boolean"
    >
      <Switch
        checked={localVal}
        disabled={props.readonly}
        onCheckedChange={() => {
          handleToggle();
          fireAction(props, "click");
        }}
      />
      <span
        className={`text-xs transition-colors ${localVal ? "text-txt font-medium" : "text-muted"}`}
      >
        {localVal ? "Enabled" : "Disabled"}
      </span>
    </div>
  );
}

// ── 5. URL ──────────────────────────────────────────────────────────────

/** URL input with type="url" browser validation. */
export function renderUrlField(props: FieldRenderProps) {
  const value = props.isSet ? String(props.value ?? "") : "";
  const placeholder =
    (props.hint.placeholder as string | undefined) ??
    (props.schema.default != null
      ? `Default: ${props.schema.default}`
      : "https://...");

  return (
    <input
      className={inputCls(!!props.errors?.length)}
      type="url"
      defaultValue={value}
      placeholder={placeholder}
      data-config-key={props.key}
      data-field-type="url"
      disabled={props.readonly}
      onChange={(e) => {
        props.onChange(e.target.value);
        fireAction(props, "change");
      }}
      onBlur={() => fireAction(props, "blur")}
      onClick={() => fireAction(props, "click")}
    />
  );
}

// ── 6. Select ───────────────────────────────────────────────────────────

/** Dropdown select. Options from hint.options or schema.enum. */
export function RenderSelectField(props: FieldRenderProps) {
  const { t } = useApp();
  const enhancedOptions = (props.hint as Record<string, unknown>).options as
    | Array<{ value: string; label: string; description?: string }>
    | undefined;

  const plainOptions: string[] =
    (props.schema.enum as string[]) ??
    props.schema.oneOf?.map((o) => String(o.const ?? o.description ?? "")) ??
    [];

  const allOptions = enhancedOptions
    ? enhancedOptions.map((o) => ({
        value: o.value,
        label: o.label,
        description: o.description,
      }))
    : plainOptions.map((o) => ({
        value: o,
        label: o,
        description: undefined as string | undefined,
      }));

  const value = props.isSet ? String(props.value ?? "") : "";
  const effectiveValue = value || String(props.schema.default ?? "");
  const useSearch = allOptions.length >= 5;
  if (useSearch) {
    return (
      <SearchableSelectInner
        fp={props}
        options={allOptions}
        effectiveValue={effectiveValue}
      />
    );
  }

  return (
    <Select
      defaultValue={effectiveValue}
      disabled={props.readonly}
      onValueChange={(value: string) => {
        props.onChange(value === "__none__" ? "" : value);
        fireAction(props, "change");
        fireAction(props, "blur");
      }}
      onOpenChange={(open: boolean) => {
        if (open) fireAction(props, "click");
      }}
    >
      <SelectTrigger
        className={inputCls(!!props.errors?.length)}
        data-config-key={props.key}
        data-field-type="select"
      >
        <SelectValue
          placeholder={
            !props.required
              ? t("config-field.None", { defaultValue: "None" })
              : undefined
          }
        />
      </SelectTrigger>
      <SelectContent>
        {!props.required && (
          <SelectItem value="__none__">
            {t("config-field.None", { defaultValue: "None" })}
          </SelectItem>
        )}
        {allOptions
          .filter((opt) => opt.value !== "")
          .map((opt) => (
            <SelectItem key={opt.value} value={opt.value}>
              {opt.label}
              {opt.description ? ` — ${opt.description}` : ""}
            </SelectItem>
          ))}
      </SelectContent>
    </Select>
  );
}

function SearchableSelectInner({
  fp: props,
  options,
  effectiveValue,
}: {
  fp: FieldRenderProps;
  options: Array<{ value: string; label: string; description?: string }>;
  effectiveValue: string;
}) {
  const { t } = useApp();
  const matchingOpt = options.find((o) => o.value === effectiveValue);
  const [inputVal, setInputVal] = useState(
    matchingOpt?.label ?? effectiveValue,
  );
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const [dropdownStyle, setDropdownStyle] = useState<React.CSSProperties>({});

  const filtered = filter
    ? options.filter(
        (o) =>
          o.label.toLowerCase().includes(filter.toLowerCase()) ||
          o.value.toLowerCase().includes(filter.toLowerCase()),
      )
    : options;

  const select = useCallback(
    (opt: { value: string; label: string }) => {
      props.onChange(opt.value);
      setInputVal(opt.label);
      setOpen(false);
      setFilter("");
      fireAction(props, "change");
    },
    [props],
  );

  // Compute portal position synchronously from the trigger rect.
  // Called in the click handler so the style is set before the portal renders.
  const computeDropdownStyle = useCallback(() => {
    if (!triggerRef.current) return {};
    const rect = triggerRef.current.getBoundingClientRect();
    return {
      position: "fixed" as const,
      top: rect.bottom + 4,
      left: rect.left,
      width: rect.width,
      zIndex: CONFIG_SELECT_FLOATING_LAYER_Z_INDEX,
    };
  }, []);

  // Close on click outside
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        triggerRef.current?.contains(target) ||
        dropdownRef.current?.contains(target)
      )
        return;
      setOpen(false);
      setFilter("");
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  // Close on page/ancestor scroll because the fixed-position portal would
  // drift, but keep the menu open while its own options list scrolls.
  useEffect(() => {
    if (!open) return;
    const handler = (event: Event) => {
      const target = event.target;
      if (target instanceof Node && dropdownRef.current?.contains(target)) {
        return;
      }
      setOpen(false);
      setFilter("");
    };
    window.addEventListener("scroll", handler, true);
    return () => window.removeEventListener("scroll", handler, true);
  }, [open]);

  return (
    <div>
      {/* Trigger button that looks like a select */}
      <Button
        ref={triggerRef}
        type="button"
        variant="outline"
        className={`${inputCls(!!props.errors?.length)} text-left flex items-center justify-between gap-2 cursor-pointer`}
        disabled={props.readonly}
        onClick={() => {
          if (!open) setDropdownStyle(computeDropdownStyle());
          setOpen(!open);
          setFilter("");
        }}
        data-config-key={props.key}
        data-field-type="select"
      >
        <span className={inputVal ? "" : "text-muted opacity-60"}>
          {inputVal || "Select..."}
        </span>
        <span className="text-muted text-2xs shrink-0">
          {open ? "\u25B2" : "\u25BC"}
        </span>
      </Button>

      {/* Dropdown panel — rendered as portal to escape overflow:hidden ancestors */}
      {open &&
        createPortal(
          <div
            ref={dropdownRef}
            data-floating-layer={CONFIG_SELECT_FLOATING_LAYER_NAME}
            style={dropdownStyle}
            className="border border-border bg-card shadow-lg rounded-sm"
          >
            {/* Search input */}
            <div className="p-1.5">
              <input
                // biome-ignore lint/a11y/noAutofocus: dropdown search needs immediate focus
                autoFocus
                className="w-full px-2 py-1.5 border border-border bg-bg text-xs font-[var(--mono)] focus:border-accent focus:outline-none rounded-sm"
                type="text"
                value={filter}
                placeholder={`Search ${options.length} options...`}
                onChange={(e) => setFilter(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    setOpen(false);
                    setFilter("");
                  } else if (e.key === "Enter" && filtered.length === 1) {
                    select(filtered[0]);
                  }
                }}
              />
            </div>
            {/* Options list */}
            <div className="overflow-y-auto overscroll-contain max-h-[220px]">
              {!props.required && (
                <Button
                  type="button"
                  variant="ghost"
                  className="w-full text-left px-3 py-1.5 text-xs text-muted hover:bg-bg-hover transition-colors italic rounded-none justify-start h-auto"
                  onClick={() => {
                    props.onChange("");
                    setInputVal("");
                    setOpen(false);
                    setFilter("");
                    fireAction(props, "change");
                  }}
                >
                  {t("config-field.None", { defaultValue: "None" })}
                </Button>
              )}
              {filtered.length === 0 && (
                <div className="px-3 py-3 text-xs text-muted text-center">
                  {t("config-field.NoMatches", {
                    defaultValue: "No matches",
                  })}
                </div>
              )}
              {filtered.map((opt) => (
                <Button
                  key={opt.value}
                  type="button"
                  variant="ghost"
                  className={`w-full text-left px-3 py-1.5 text-xs hover:bg-bg-hover transition-colors rounded-none justify-start h-auto ${
                    opt.value === effectiveValue
                      ? "bg-[color-mix(in_srgb,var(--accent)_10%,var(--card))] text-accent font-medium"
                      : ""
                  }`}
                  onClick={() => select(opt)}
                >
                  {opt.label}
                  {opt.description && (
                    <span className="text-muted ml-1.5 text-xs-tight">
                      {opt.description}
                    </span>
                  )}
                </Button>
              ))}
            </div>
            <div className="px-3 py-1 text-2xs text-muted">
              {filtered.length} of {options.length}{" "}
              {t("config-field.options", { defaultValue: "options" })}
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}

// ── 7. Textarea ─────────────────────────────────────────────────────────

/** Multi-line text input with auto-resize. Auto-detected for maxLength > 200. */
export function renderTextareaField(props: FieldRenderProps) {
  return <TextareaFieldInner fp={props} />;
}

function TextareaFieldInner({ fp: props }: { fp: FieldRenderProps }) {
  const value = props.isSet ? String(props.value ?? "") : "";
  const placeholder =
    (props.hint.placeholder as string | undefined) ?? "Enter text...";
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const autoResize = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    // Check if field-sizing is supported — if so, CSS handles it
    if (globalThis.CSS?.supports?.("field-sizing", "content")) return;
    el.style.height = "auto";
    el.style.height = `${Math.max(72, el.scrollHeight)}px`;
  }, []);

  return (
    <textarea
      ref={textareaRef}
      className={textareaCls(!!props.errors?.length)}
      style={{ fieldSizing: "content" } as React.CSSProperties}
      defaultValue={value}
      placeholder={placeholder}
      data-config-key={props.key}
      data-field-type="textarea"
      disabled={props.readonly}
      onChange={(e) => {
        props.onChange(e.target.value);
        fireAction(props, "change");
        autoResize();
      }}
      onBlur={() => fireAction(props, "blur")}
      onClick={() => fireAction(props, "click")}
      onFocus={autoResize}
    />
  );
}

// ── 8. Email ────────────────────────────────────────────────────────────

/** Email input with type="email" browser validation. */
export function renderEmailField(props: FieldRenderProps) {
  const value = props.isSet ? String(props.value ?? "") : "";
  const placeholder =
    (props.hint.placeholder as string | undefined) ?? "user@example.com";

  return (
    <input
      className={inputCls(!!props.errors?.length)}
      type="email"
      defaultValue={value}
      placeholder={placeholder}
      data-config-key={props.key}
      data-field-type="email"
      disabled={props.readonly}
      onChange={(e) => {
        props.onChange(e.target.value);
        fireAction(props, "change");
      }}
      onBlur={() => fireAction(props, "blur")}
      onClick={() => fireAction(props, "click")}
    />
  );
}

// ── 9. Color ────────────────────────────────────────────────────────────

/** Color picker swatch paired with a hex text input. */
export function renderColorField(props: FieldRenderProps) {
  return <ColorFieldInner fp={props} />;
}

function ColorFieldInner({ fp: props }: { fp: FieldRenderProps }) {
  const initial = props.isSet ? String(props.value ?? "#000000") : "#000000";
  const [color, setColor] = useState(initial);

  const handleChange = (newColor: string) => {
    setColor(newColor);
    props.onChange(newColor);
    fireAction(props, "change");
  };

  return (
    <div className="flex items-center gap-2">
      <input
        className="w-[36px] h-9 border border-border p-0.5 cursor-pointer bg-transparent rounded-sm [&::-webkit-color-swatch-wrapper]:p-0 [&::-webkit-color-swatch]:border-none [&::-webkit-color-swatch]:rounded-sm"
        type="color"
        value={color}
        data-config-key={props.key}
        data-field-type="color"
        disabled={props.readonly}
        onChange={(e) => handleChange(e.target.value)}
        onBlur={() => fireAction(props, "blur")}
        onClick={() => fireAction(props, "click")}
      />
      <input
        className={`${inputCls(!!props.errors?.length)} flex-1`}
        type="text"
        value={color}
        placeholder="#000000"
        data-config-key={props.key}
        data-field-type="color-text"
        disabled={props.readonly}
        onChange={(e) => handleChange(e.target.value)}
        onBlur={() => fireAction(props, "blur")}
        onClick={() => fireAction(props, "click")}
      />
    </div>
  );
}

// ── 10. Radio ───────────────────────────────────────────────────────────

/** Vertical radio button group. Supports per-option descriptions. */
export function renderRadioField(props: FieldRenderProps) {
  return <RadioFieldInner fp={props} />;
}

function RadioFieldInner({ fp: props }: { fp: FieldRenderProps }) {
  const options: Array<{
    value: string;
    label: string;
    description?: string;
    disabled?: boolean;
  }> =
    ((props.hint as Record<string, unknown>).options as
      | typeof options
      | undefined) ??
    ((props.schema.enum as string[]) ?? []).map((v) => ({
      value: String(v),
      label: String(v),
    }));

  const initial = props.isSet
    ? String(props.value ?? "")
    : String(props.schema.default ?? "");
  const [selected, setSelected] = useState(initial);

  const handleChange = (val: string) => {
    setSelected(val);
    props.onChange(val);
    fireAction(props, "change");
  };

  return (
    <div
      className="flex flex-col gap-1.5"
      data-config-key={props.key}
      data-field-type="radio"
    >
      {options.map((opt) => (
        <label
          key={opt.value}
          className="flex items-start gap-2 cursor-pointer text-sm"
        >
          <input
            type="radio"
            name={props.key}
            value={opt.value}
            checked={opt.value === selected}
            disabled={props.readonly || opt.disabled}
            onChange={() => handleChange(opt.value)}
            onClick={() => fireAction(props, "click")}
            onBlur={() => fireAction(props, "blur")}
            className="mt-0.5 shrink-0"
          />
          <span>
            {opt.label}
            {opt.description && (
              <div className="text-xs-tight text-muted mt-px">
                {opt.description}
              </div>
            )}
          </span>
        </label>
      ))}
    </div>
  );
}

// ── 11. Multiselect ─────────────────────────────────────────────────────

/** Checkbox group for selecting multiple values from options. */
export function renderMultiselectField(props: FieldRenderProps) {
  return <MultiselectFieldInner fp={props} />;
}

function MultiselectFieldInner({ fp: props }: { fp: FieldRenderProps }) {
  const options: Array<{ value: string; label: string }> =
    ((props.hint as Record<string, unknown>).options as
      | typeof options
      | undefined) ??
    ((props.schema.items?.enum as string[]) ?? []).map((v) => ({
      value: String(v),
      label: String(v),
    }));

  const rawVal = props.isSet ? props.value : [];
  const initialSet = new Set(Array.isArray(rawVal) ? rawVal.map(String) : []);
  const [selected, setSelected] = useState(initialSet);

  const toggle = (optValue: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(optValue)) {
        next.delete(optValue);
      } else {
        next.add(optValue);
      }
      props.onChange([...next]);
      fireAction(props, "change");
      return next;
    });
  };

  const remove = (optValue: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      next.delete(optValue);
      props.onChange([...next]);
      fireAction(props, "change");
      return next;
    });
  };

  const selectedOptions = options.filter((o) => selected.has(o.value));

  return (
    <div
      className="flex flex-col gap-2"
      data-config-key={props.key}
      data-field-type="multiselect"
    >
      {/* Selected tag pills */}
      {selectedOptions.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {selectedOptions.map((opt) => (
            <span
              key={opt.value}
              className="inline-flex items-center gap-1 px-2 py-0.5 text-xs-tight bg-accent-subtle text-accent border border-accent border-opacity-30 rounded-full"
            >
              {opt.label}
              {!props.readonly && (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="inline-flex items-center justify-center w-3.5 h-3.5 text-2xs rounded-full hover:bg-accent hover:text-accent-fg transition-colors"
                  onClick={() => remove(opt.value)}
                >
                  ×
                </Button>
              )}
            </span>
          ))}
        </div>
      )}
      {/* Checkbox list */}
      <div className="flex flex-col gap-1">
        {options.map((opt) => (
          // biome-ignore lint/a11y/noLabelWithoutControl: form control is associated programmatically
          <label
            key={opt.value}
            className="flex items-center gap-2 cursor-pointer text-sm"
          >
            <Checkbox
              checked={selected.has(opt.value)}
              disabled={props.readonly}
              onCheckedChange={() => {
                toggle(opt.value);
                fireAction(props, "click");
              }}
            />
            <span>{opt.label}</span>
          </label>
        ))}
      </div>
    </div>
  );
}

// ── 12. Date ────────────────────────────────────────────────────────────

/** Native date picker input. */
export function renderDateField(props: FieldRenderProps) {
  const value = props.isSet ? String(props.value ?? "") : "";
  const inputType =
    props.schema.format === "date-time" ? "datetime-local" : "date";

  return (
    <input
      className={inputCls(!!props.errors?.length)}
      type={inputType}
      defaultValue={value}
      data-config-key={props.key}
      data-field-type="date"
      disabled={props.readonly}
      onChange={(e) => {
        props.onChange(e.target.value);
        fireAction(props, "change");
      }}
      onBlur={() => fireAction(props, "blur")}
      onClick={() => fireAction(props, "click")}
    />
  );
}

// ── 13. JSON ────────────────────────────────────────────────────────────

/** JSON editor textarea with parse validation on blur. Shows inline error for invalid JSON. */
export function renderJsonField(props: FieldRenderProps) {
  return <JsonFieldInner fp={props} />;
}

function JsonFieldInner({ fp: props }: { fp: FieldRenderProps }) {
  const { t } = useApp();
  const initial = props.isSet ? String(props.value ?? "") : "";
  const [jsonError, setJsonError] = useState<string | null>(null);

  const handleBlur = (e: React.FocusEvent<HTMLTextAreaElement>) => {
    const val = e.target.value.trim();
    if (val) {
      try {
        const parsed = JSON.parse(val);
        const jsonStr = JSON.stringify(parsed);
        if (/__proto__|constructor\s*:/.test(jsonStr)) {
          setJsonError("Unsafe JSON: contains dangerous keys");
          return;
        }
        setJsonError(null);
      } catch (err) {
        setJsonError(err instanceof Error ? err.message : "Invalid JSON");
      }
    } else {
      setJsonError(null);
    }
    fireAction(props, "blur");
  };

  return (
    <div>
      <textarea
        className={textareaCls(
          Boolean(jsonError || props.errors?.length),
          "min-h-[100px]",
        )}
        defaultValue={initial}
        placeholder={
          props.hint.placeholder ||
          t("config-field.KeyValue", { defaultValue: "Key-value JSON" })
        }
        rows={6}
        data-config-key={props.key}
        data-field-type="json"
        disabled={props.readonly}
        onChange={(e) => {
          props.onChange(e.target.value);
          fireAction(props, "change");
        }}
        onBlur={handleBlur}
        onClick={() => fireAction(props, "click")}
      />
      {jsonError && (
        <div className="text-xs-tight text-destructive mt-1 leading-snug">
          {jsonError}
        </div>
      )}
    </div>
  );
}

// ── 14. Code ────────────────────────────────────────────────────────────

/** Monospaced code editor textarea for templates and snippets. */
export function renderCodeField(props: FieldRenderProps) {
  const value = props.isSet ? String(props.value ?? "") : "";
  const placeholder =
    (props.hint.placeholder as string | undefined) ?? "Enter code...";

  return (
    <textarea
      className={textareaCls(!!props.errors?.length, "min-h-[100px]")}
      defaultValue={value}
      placeholder={placeholder}
      rows={6}
      data-config-key={props.key}
      data-field-type="code"
      disabled={props.readonly}
      onChange={(e) => {
        props.onChange(e.target.value);
        fireAction(props, "change");
      }}
      onBlur={() => fireAction(props, "blur")}
      onClick={() => fireAction(props, "click")}
    />
  );
}

// ── 15. Array ───────────────────────────────────────────────────────────

/** Add/remove items list. Max 100 items. Parses comma-separated strings. */
export function renderArrayField(props: FieldRenderProps) {
  return <ArrayFieldInner fp={props} />;
}

function ArrayItem({
  index,
  value,
  total,
  hasError,
  readonly,
  onChange,
  onRemove,
  onMoveUp,
  onMoveDown,
  onBlur,
}: {
  index: number;
  value: string;
  total: number;
  hasError: boolean;
  readonly?: boolean;
  onChange: (value: string) => void;
  onRemove: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onBlur: () => void;
}) {
  const { t } = useApp();
  return (
    <div className="flex items-center gap-1">
      {!readonly && (
        <div className="flex flex-col shrink-0">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="px-1 py-0 h-auto w-auto text-2xs leading-tight text-muted hover:text-txt disabled:opacity-30 disabled:cursor-not-allowed"
            onClick={onMoveUp}
            disabled={index === 0}
            title={t("config-field.MoveUp", {
              defaultValue: "Move up",
            })}
          >
            ▲
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="px-1 py-0 h-auto w-auto text-2xs leading-tight text-muted hover:text-txt disabled:opacity-30 disabled:cursor-not-allowed"
            onClick={onMoveDown}
            disabled={index === total - 1}
            title={t("config-field.MoveDown", {
              defaultValue: "Move down",
            })}
          >
            <ChevronDown className="w-3 h-3" />
          </Button>
        </div>
      )}
      <input
        className={`${inputCls(hasError)} flex-1`}
        type="text"
        value={value}
        placeholder={`Item ${index + 1}`}
        disabled={readonly}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onBlur}
      />
      {!readonly && (
        <Button
          type="button"
          variant="outline"
          size="icon"
          className="px-2 py-1.5 bg-bg-hover text-xs text-muted transition-colors hover:bg-surface hover:text-destructive h-9 rounded-sm"
          onClick={onRemove}
        >
          <X className="w-3 h-3" />
        </Button>
      )}
    </div>
  );
}

function ArrayFieldInner({ fp: props }: { fp: FieldRenderProps }) {
  const { t } = useApp();
  const rawVal = props.isSet ? props.value : [];
  const initialItems: string[] = Array.isArray(rawVal)
    ? rawVal.map(String)
    : [];
  const [items, setItems] = useState<string[]>(initialItems);

  const updateItems = (nextItems: string[]) => {
    setItems(nextItems);
    props.onChange(nextItems);
    fireAction(props, "change");
  };

  const MAX_ARRAY_ITEMS = 100;
  const addItem = () => {
    if (items.length >= MAX_ARRAY_ITEMS) return;
    updateItems([...items, ""]);
  };

  const removeItem = (index: number) => {
    updateItems(items.filter((_, i) => i !== index));
  };

  const changeItem = (index: number, value: string) => {
    const next = [...items];
    next[index] = value;
    updateItems(next);
  };

  const moveItem = (from: number, to: number) => {
    const next = [...items];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    updateItems(next);
  };

  return (
    <div
      className="flex flex-col gap-1.5"
      data-config-key={props.key}
      data-field-type="array"
    >
      {items.map((item, index) => (
        <ArrayItem
          // biome-ignore lint/suspicious/noArrayIndexKey: composite key with index as tiebreaker
          key={`${index}-${items.length}`}
          index={index}
          value={item}
          total={items.length}
          hasError={!!props.errors?.length}
          readonly={props.readonly}
          onChange={(v) => changeItem(index, v)}
          onRemove={() => {
            removeItem(index);
            fireAction(props, "click");
          }}
          onMoveUp={() => moveItem(index, index - 1)}
          onMoveDown={() => moveItem(index, index + 1)}
          onBlur={() => fireAction(props, "blur")}
        />
      ))}
      {!props.readonly && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="self-start px-3 py-1.5 border-dashed bg-transparent text-xs-tight text-muted transition-colors hover:bg-bg-hover hover:text-txt hover:border-accent rounded-sm"
          onClick={() => {
            addItem();
            fireAction(props, "click");
          }}
        >
          {t("config-field.AddItem", { defaultValue: "Add item" })}
        </Button>
      )}
    </div>
  );
}

// ── 16. Key-Value ───────────────────────────────────────────────────────

/** Key-value pair editor with add/remove rows. Blocks prototype pollution keys. */
export function renderKeyValueField(props: FieldRenderProps) {
  return <KeyValueFieldInner fp={props} />;
}

function KeyValueFieldInner({ fp: props }: { fp: FieldRenderProps }) {
  const { t } = useApp();
  const rawVal = props.isSet ? props.value : {};
  const initialPairs: Array<{ key: string; value: string }> =
    rawVal && typeof rawVal === "object" && !Array.isArray(rawVal)
      ? Object.entries(rawVal as Record<string, unknown>).map(([k, v]) => ({
          key: k,
          value: String(v ?? ""),
        }))
      : [];
  const [pairs, setPairs] = useState(initialPairs);

  const emitChange = (next: Array<{ key: string; value: string }>) => {
    setPairs(next);
    const obj: Record<string, string> = {};
    for (const p of next) {
      if (p.key) obj[p.key] = p.value;
    }
    props.onChange(obj);
    fireAction(props, "change");
  };

  const addRow = () => {
    emitChange([...pairs, { key: "", value: "" }]);
  };

  const removeRow = (index: number) => {
    emitChange(pairs.filter((_, i) => i !== index));
  };

  const BLOCKED_KEYS = ["__proto__", "constructor", "prototype"];
  const updateRow = (index: number, field: "key" | "value", val: string) => {
    if (field === "key" && BLOCKED_KEYS.includes(val)) return;
    const next = [...pairs];
    next[index] = { ...next[index], [field]: val };
    emitChange(next);
  };

  return (
    <div
      className="flex flex-col gap-1.5"
      data-config-key={props.key}
      data-field-type="keyvalue"
    >
      {pairs.map((pair, index) => (
        <div
          key={`${pair.key}:${pair.value}`}
          className="flex items-center gap-1"
        >
          <input
            className={`${inputCls(!!props.errors?.length)} flex-1`}
            type="text"
            value={pair.key}
            placeholder={t("config-field.Key", { defaultValue: "Key" })}
            disabled={props.readonly}
            onChange={(e) => updateRow(index, "key", e.target.value)}
            onBlur={() => fireAction(props, "blur")}
          />
          <input
            className={`${inputCls(!!props.errors?.length)} flex-1`}
            type="text"
            value={pair.value}
            placeholder={t("common.value", { defaultValue: "Value" })}
            disabled={props.readonly}
            onChange={(e) => updateRow(index, "value", e.target.value)}
            onBlur={() => fireAction(props, "blur")}
          />
          {!props.readonly && (
            <Button
              type="button"
              variant="outline"
              size="icon"
              className="px-2 py-1.5 bg-bg-hover text-xs text-muted transition-colors hover:bg-surface hover:text-destructive h-9 rounded-sm"
              onClick={() => {
                removeRow(index);
                fireAction(props, "click");
              }}
            >
              <X className="w-3 h-3" />
            </Button>
          )}
        </div>
      ))}
      {!props.readonly && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="self-start px-3 py-1.5 border-dashed bg-transparent text-xs-tight text-muted transition-colors hover:bg-bg-hover hover:text-txt hover:border-accent rounded-sm"
          onClick={() => {
            addRow();
            fireAction(props, "click");
          }}
        >
          {t("config-field.AddRow", { defaultValue: "Add row" })}
        </Button>
      )}
    </div>
  );
}

// ── 17. Datetime ────────────────────────────────────────────────────────

/** Combined date and time picker (datetime-local). */
export function renderDatetimeField(props: FieldRenderProps) {
  const value = props.isSet ? String(props.value ?? "") : "";

  return (
    <input
      className={inputCls(!!props.errors?.length)}
      type="datetime-local"
      defaultValue={value}
      data-config-key={props.key}
      data-field-type="datetime"
      disabled={props.readonly}
      onChange={(e) => {
        props.onChange(e.target.value);
        fireAction(props, "change");
      }}
      onBlur={() => fireAction(props, "blur")}
      onClick={() => fireAction(props, "click")}
    />
  );
}

// ── 18. File ────────────────────────────────────────────────────────────

/** File path text input with path traversal guard. */
export function RenderFileField(props: FieldRenderProps) {
  const { t } = useApp();
  const value = props.isSet ? String(props.value ?? "") : "";
  const placeholder =
    (props.hint.placeholder as string | undefined) ?? "/path/to/file";

  return (
    <div>
      <input
        className={inputCls(!!props.errors?.length)}
        type="text"
        defaultValue={value}
        placeholder={placeholder}
        data-config-key={props.key}
        data-field-type="file"
        disabled={props.readonly}
        onChange={(e) => {
          const v = e.target.value;
          if (v.includes("..")) return; // block path traversal
          props.onChange(v);
          fireAction(props, "change");
        }}
        onBlur={() => fireAction(props, "blur")}
        onClick={() => fireAction(props, "click")}
      />
      <div className="text-xs-tight text-muted mt-0.5">
        {t("config-field.EnterAFilePathOr", {
          defaultValue: "Enter a file path or paste one here.",
        })}
      </div>
    </div>
  );
}

// ── 19. Custom ──────────────────────────────────────────────────────────

/** Placeholder for plugin-provided custom React components. */
export function RenderCustomField(props: FieldRenderProps) {
  const { t } = useApp();
  const componentName = (props.hint as Record<string, unknown>).component as
    | string
    | undefined;

  return (
    <div
      className="px-3 py-4 border border-dashed border-border bg-bg-hover text-sm text-muted"
      data-config-key={props.key}
      data-field-type="custom"
    >
      {t("config-field.CustomComponent", {
        defaultValue: "Custom component:",
      })}{" "}
      {componentName ?? props.fieldType}
    </div>
  );
}

// ── 20. Markdown ─────────────────────────────────────────────────────────

/**
 * Simple markdown renderer for preview mode.
 * Converts basic markdown patterns to React elements without external dependencies.
 */
function renderMarkdown(text: string): React.ReactNode {
  if (!text) return null;

  const blocks = text.split(/\n\n+/);
  const elements: React.ReactNode[] = [];

  blocks.forEach((block) => {
    const trimmed = block.trim();
    if (!trimmed) return;

    // Fenced code block
    if (trimmed.startsWith("```")) {
      const lines = trimmed.split("\n");
      const code = lines.slice(1, -1).join("\n");
      elements.push(
        <pre
          key={`code:${code}`}
          className="bg-bg-hover px-3 py-2 rounded-sm overflow-x-auto my-2"
        >
          <code className="font-mono text-xs">{code}</code>
        </pre>,
      );
      return;
    }

    // Heading
    const headingMatch = trimmed.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const content = processInline(headingMatch[2]);
      const sizes = [
        "text-xl",
        "text-lg",
        "text-base",
        "text-sm",
        "text-sm",
        "text-xs",
      ];
      const cls = `${sizes[level - 1]} font-bold mb-1 mt-2`;
      elements.push(
        React.createElement(
          `h${level}`,
          { key: `heading:${headingMatch[2]}`, className: cls },
          content,
        ),
      );
      return;
    }

    // Unordered list
    if (/^[-*]\s/.test(trimmed)) {
      const items = trimmed.split("\n").filter((l) => /^[-*]\s/.test(l));
      elements.push(
        <ul key={`list:${trimmed}`} className="list-disc pl-4 my-2 space-y-1">
          {items.map((item) => (
            <li key={item}>{processInline(item.replace(/^[-*]\s/, ""))}</li>
          ))}
        </ul>,
      );
      return;
    }

    // Regular paragraph
    elements.push(
      <p key={`paragraph:${trimmed}`} className="my-2">
        {processInline(trimmed)}
      </p>,
    );
  });

  return <>{elements}</>;
}

/**
 * Process inline markdown patterns (bold, italic, code, links).
 */
function processInline(text: string): React.ReactNode {
  const parts: React.ReactNode[] = [];
  let remaining = text;
  let key = 0;

  while (remaining) {
    // Link: [text](url)
    const linkMatch = remaining.match(/\[([^\]]+)\]\(([^)]+)\)/);
    if (linkMatch) {
      const before = remaining.substring(0, linkMatch.index);
      if (before) parts.push(processSimpleInline(before, key++));
      parts.push(
        <a
          key={key++}
          href={linkMatch[2]}
          target="_blank"
          rel="noopener noreferrer"
          className="text-accent underline"
        >
          {linkMatch[1]}
        </a>,
      );
      const linkIndex = linkMatch.index ?? 0;
      remaining = remaining.substring(linkIndex + linkMatch[0].length);
      continue;
    }

    // Inline code: `code`
    const codeMatch = remaining.match(/`([^`]+)`/);
    if (codeMatch) {
      const before = remaining.substring(0, codeMatch.index);
      if (before) parts.push(processSimpleInline(before, key++));
      parts.push(
        <code
          key={key++}
          className="bg-bg-hover px-1 py-0.5 rounded font-mono text-xs"
        >
          {codeMatch[1]}
        </code>,
      );
      const codeIndex = codeMatch.index ?? 0;
      remaining = remaining.substring(codeIndex + codeMatch[0].length);
      continue;
    }

    // Bold: **text**
    const boldMatch = remaining.match(/\*\*([^*]+)\*\*/);
    if (boldMatch) {
      const before = remaining.substring(0, boldMatch.index);
      if (before) parts.push(processSimpleInline(before, key++));
      parts.push(<strong key={key++}>{boldMatch[1]}</strong>);
      const boldIndex = boldMatch.index ?? 0;
      remaining = remaining.substring(boldIndex + boldMatch[0].length);
      continue;
    }

    // Italic: *text* or _text_
    const italicMatch = remaining.match(/(\*|_)([^*_]+)\1/);
    if (italicMatch) {
      const before = remaining.substring(0, italicMatch.index);
      if (before) parts.push(processSimpleInline(before, key++));
      parts.push(<em key={key++}>{italicMatch[2]}</em>);
      const italicIndex = italicMatch.index ?? 0;
      remaining = remaining.substring(italicIndex + italicMatch[0].length);
      continue;
    }

    // No more patterns found
    parts.push(remaining);
    break;
  }

  return <>{parts}</>;
}

/**
 * Helper to handle plain text without additional patterns.
 */
function processSimpleInline(text: string, key: number): React.ReactNode {
  return <span key={key}>{text}</span>;
}

function MarkdownFieldInner(props: FieldRenderProps) {
  const { t } = useApp();
  const [preview, setPreview] = useState(false);
  const value = typeof props.value === "string" ? props.value : "";

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2 mb-1">
        <Button
          type="button"
          variant={!preview ? "default" : "outline"}
          size="sm"
          className={`text-xs-tight px-2 py-0.5 transition-colors h-auto ${
            !preview
              ? "bg-accent text-accent-fg border-accent"
              : "bg-transparent text-muted hover:text-txt"
          }`}
          onClick={() => setPreview(false)}
        >
          {t("common.edit", { defaultValue: "Edit" })}
        </Button>
        <Button
          type="button"
          variant={preview ? "default" : "outline"}
          size="sm"
          className={`text-xs-tight px-2 py-0.5 transition-colors h-auto ${
            preview
              ? "bg-accent text-accent-fg border-accent"
              : "bg-transparent text-muted hover:text-txt"
          }`}
          onClick={() => setPreview(true)}
        >
          {t("common.preview", { defaultValue: "Preview" })}
        </Button>
      </div>
      {preview ? (
        <div
          className="min-h-[100px] px-3 py-2 border border-border bg-surface text-sm leading-relaxed"
          data-config-key={props.key}
          data-field-type="markdown"
        >
          {value ? (
            renderMarkdown(value)
          ) : (
            <span className="text-muted italic">
              {t("config-field.NothingToPreview", {
                defaultValue: "Nothing to preview",
              })}
            </span>
          )}
        </div>
      ) : (
        <textarea
          className={textareaCls(
            !!props.errors?.length,
            "min-h-[100px] h-auto",
          )}
          defaultValue={value}
          placeholder={props.hint.placeholder ?? "Markdown content..."}
          data-config-key={props.key}
          data-field-type="markdown"
          disabled={props.readonly}
          onChange={(e) => {
            props.onChange(e.target.value);
            fireAction(props, "change");
          }}
          onBlur={() => fireAction(props, "blur")}
        />
      )}
    </div>
  );
}
/** Markdown textarea with Edit/Preview toggle. */
export const renderMarkdownField: FieldRenderer = (props) => (
  <MarkdownFieldInner {...props} />
);

// ── 21. Checkbox Group ───────────────────────────────────────────────────

function CheckboxGroupInner(props: FieldRenderProps) {
  const { t } = useApp();
  const selected = new Set(
    Array.isArray(props.value)
      ? (props.value as string[])
      : typeof props.value === "string" && props.value
        ? props.value.split(",").map((s) => s.trim())
        : [],
  );
  const options: Array<{
    value: string;
    label: string;
    description?: string;
    disabled?: boolean;
  }> =
    props.hint.options ??
    (props.schema.enum as string[] | undefined)?.map((v) => ({
      value: v,
      label: v,
    })) ??
    [];

  const toggle = (val: string) => {
    const next = new Set(selected);
    if (next.has(val)) next.delete(val);
    else next.add(val);
    props.onChange([...next]);
    fireAction(props, "change");
  };

  return (
    <div
      className="flex flex-col gap-1.5"
      data-config-key={props.key}
      data-field-type="checkbox-group"
    >
      {options.map((opt) => (
        // biome-ignore lint/a11y/noLabelWithoutControl: form control is associated programmatically
        <label
          key={opt.value}
          className={`flex items-start gap-2.5 px-3 py-2 border border-border bg-card cursor-pointer transition-colors hover:bg-bg-hover ${
            selected.has(opt.value)
              ? "border-accent bg-[color-mix(in_srgb,var(--accent)_5%,var(--card))]"
              : ""
          } ${opt.disabled ? "opacity-50 pointer-events-none" : ""}`}
        >
          <Checkbox
            checked={selected.has(opt.value)}
            disabled={props.readonly || opt.disabled}
            onCheckedChange={() => toggle(opt.value)}
            className="mt-0.5"
          />
          <div className="flex flex-col">
            <span className="text-sm">{opt.label}</span>
            {opt.description && (
              <span className="text-xs-tight text-muted mt-0.5">
                {opt.description}
              </span>
            )}
          </div>
        </label>
      ))}
      {options.length === 0 && (
        <span className="text-xs-tight text-muted italic">
          {t("config-field.NoOptionsDefined", {
            defaultValue: "No options defined",
          })}
        </span>
      )}
    </div>
  );
}
/** Vertical checkbox list with per-option descriptions and accent highlighting. */
export const renderCheckboxGroupField: FieldRenderer = (props) => (
  <CheckboxGroupInner {...props} />
);

// ── 22. Group ────────────────────────────────────────────────────────────

/** Fieldset container with legend label. */
export const renderGroupField: FieldRenderer = (props) => {
  const value = typeof props.value === "string" ? props.value : "";
  return (
    <fieldset
      className="border border-border px-4 py-3 bg-surface"
      data-config-key={props.key}
      data-field-type="group"
    >
      <legend className="text-xs font-semibold text-muted px-1.5">
        {props.hint.label ?? props.key}
      </legend>
      <textarea
        className={textareaCls(!!props.errors?.length, "min-h-[60px] h-auto")}
        defaultValue={value}
        placeholder={props.hint.placeholder ?? "Group configuration..."}
        disabled={props.readonly}
        onChange={(e) => {
          props.onChange(e.target.value);
          fireAction(props, "change");
        }}
        onBlur={() => fireAction(props, "blur")}
      />
    </fieldset>
  );
};

// ── 23. Table ────────────────────────────────────────────────────────────

function TableFieldInner(props: FieldRenderProps) {
  const { t } = useApp();
  const MAX_TABLE_ROWS = 50;
  const columns: Array<{ key: string; label: string }> = ((
    props.hint as Record<string, unknown>
  ).columns as Array<{ key: string; label: string }>) ?? [
    { key: "key", label: "Key" },
    { key: "value", label: "Value" },
  ];

  const rawRows = Array.isArray(props.value)
    ? (props.value as Record<string, string>[])
    : [];
  const [rows, setRows] = useState<Record<string, string>[]>(
    rawRows.length > 0
      ? rawRows
      : [Object.fromEntries(columns.map((c) => [c.key, ""]))],
  );

  const emit = (next: Record<string, string>[]) => {
    setRows(next);
    props.onChange(next.filter((r) => columns.some((c) => r[c.key]?.trim())));
    fireAction(props, "change");
  };

  const updateCell = (rowIdx: number, colKey: string, val: string) => {
    if (["__proto__", "constructor", "prototype"].includes(colKey)) return;
    const next = [...rows];
    next[rowIdx] = { ...next[rowIdx], [colKey]: val };
    emit(next);
  };

  const addRow = () => {
    if (rows.length >= MAX_TABLE_ROWS) return;
    emit([...rows, Object.fromEntries(columns.map((c) => [c.key, ""]))]);
  };

  const removeRow = (idx: number) => {
    if (rows.length <= 1) return;
    emit(rows.filter((_, i) => i !== idx));
  };

  return (
    <div
      className="flex flex-col gap-1.5"
      data-config-key={props.key}
      data-field-type="table"
    >
      <div className="border border-border overflow-x-auto">
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr className="bg-surface">
              {columns.map((col) => (
                <th
                  key={col.key}
                  className="text-left text-xs-tight font-semibold text-muted px-3 py-1.5"
                >
                  {col.label}
                </th>
              ))}
              <th className="w-[36px]" />
            </tr>
          </thead>
          <tbody>
            {rows.map((row, ri) => (
              <tr key={JSON.stringify(row)} className="">
                {columns.map((col) => (
                  <td key={col.key} className="px-1 py-0.5">
                    <input
                      className="w-full px-2 py-1 bg-transparent text-sm border-none outline-none focus:bg-bg-hover"
                      value={row[col.key] ?? ""}
                      placeholder={col.label}
                      disabled={props.readonly}
                      onChange={(e) => updateCell(ri, col.key, e.target.value)}
                    />
                  </td>
                ))}
                <td className="text-center">
                  {!props.readonly && rows.length > 1 && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="text-muted hover:text-destructive text-sm px-1 h-auto w-auto"
                      onClick={() => removeRow(ri)}
                      title={t("config-field.RemoveRow", {
                        defaultValue: "Remove row",
                      })}
                    >
                      {t("config-field.Times")}
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!props.readonly && rows.length < MAX_TABLE_ROWS && (
        <Button
          type="button"
          variant="link"
          size="sm"
          className="self-start text-xs-tight text-accent hover:underline p-0 h-auto"
          onClick={addRow}
        >
          {t("config-field.AddRow", { defaultValue: "Add row" })}
        </Button>
      )}
    </div>
  );
}
/** Tabular data editor with configurable columns. Max 50 rows. */
export const renderTableField: FieldRenderer = (props) => (
  <TableFieldInner {...props} />
);

// ── Default renderers map ───────────────────────────────────────────────

export const defaultRenderers: Record<string, FieldRenderer> = {
  text: renderTextField,
  password: renderPasswordField,
  number: renderNumberField,
  boolean: renderBooleanField,
  url: renderUrlField,
  select: RenderSelectField,
  textarea: renderTextareaField,
  email: renderEmailField,
  color: renderColorField,
  radio: renderRadioField,
  multiselect: renderMultiselectField,
  date: renderDateField,
  json: renderJsonField,
  code: renderCodeField,
  array: renderArrayField,
  keyvalue: renderKeyValueField,
  datetime: renderDatetimeField,
  file: RenderFileField,
  custom: RenderCustomField,
  markdown: renderMarkdownField,
  "checkbox-group": renderCheckboxGroupField,
  group: renderGroupField,
  table: renderTableField,
};

// ── ConfigField wrapper component ───────────────────────────────────────

/**
 * Wraps a field renderer with the standard label row, env key display,
 * help text, and error messages.
 */
export function ConfigField({
  renderProps,
  renderer,
  pluginId,
}: {
  renderProps: FieldRenderProps;
  renderer: FieldRenderer;
  pluginId?: string;
}) {
  const { t } = useApp();
  const label = renderProps.hint.label ?? renderProps.key;
  const errors = renderProps.errors ?? [];
  const hasError = errors.length > 0;
  const isRequiredEmpty = renderProps.required && !renderProps.isSet;

  const renderFn =
    renderer ??
    defaultRenderers[renderProps.fieldType] ??
    defaultRenderers.text;

  return (
    <div
      id={
        pluginId
          ? `field-${pluginId}-${renderProps.key}`
          : `field-${renderProps.key}`
      }
      className={`py-2.5 group/field ${
        renderProps.readonly ? "opacity-50 pointer-events-none" : ""
      } ${isRequiredEmpty ? "relative" : ""}`}
    >
      {/* Required-but-empty accent bar */}
      {isRequiredEmpty && (
        <div className="absolute left-0 top-2.5 bottom-2.5 w-[2px] bg-destructive opacity-40 rounded-full" />
      )}

      <div className={isRequiredEmpty ? "pl-2.5" : ""}>
        {/* Label row */}
        <div className="flex items-center gap-2 mb-1.5">
          <span
            className="font-semibold leading-tight"
            style={{
              fontSize: "var(--plugin-label-size)",
              color: "var(--plugin-label)",
            }}
          >
            {label}
          </span>
          {renderProps.required && !renderProps.isSet && (
            <span className="text-2xs text-destructive font-semibold px-1.5 py-px bg-[color-mix(in_srgb,var(--destructive)_10%,transparent)] rounded-sm shrink-0">
              {t("secretsview.Required")}
            </span>
          )}
          {renderProps.isSet && (
            <span className="inline-flex items-center gap-1 text-2xs text-ok font-medium shrink-0">
              <span className="inline-block w-1.5 h-1.5 rounded-full bg-ok" />

              {t("config-field.Configured")}
            </span>
          )}
        </div>

        {/* Field renderer */}
        {renderFn(renderProps)}

        {/* Errors */}
        {hasError && (
          <div className="mt-1.5 flex flex-col gap-0.5">
            {errors.map((err) => (
              <div
                key={err}
                className="leading-snug flex items-start gap-1"
                style={{
                  fontSize: "var(--plugin-error-size)",
                  color: "var(--plugin-error)",
                }}
              >
                <span className="shrink-0 mt-px">
                  {t("config-field.Times")}
                </span>
                <span>{err}</span>
              </div>
            ))}
          </div>
        )}

        {/* Help text */}
        {(renderProps.hint.help || renderProps.schema.description) && (
          <div
            className="mt-1 leading-relaxed line-clamp-2"
            style={{
              fontSize: "var(--plugin-help-size)",
              color: "var(--plugin-help)",
            }}
          >
            {renderProps.hint.help ?? renderProps.schema.description}
            {renderProps.schema.default != null && (
              <span className="opacity-70">
                {" "}
                {t("common.default", { defaultValue: "Default" })}{" "}
                {String(renderProps.schema.default)})
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
