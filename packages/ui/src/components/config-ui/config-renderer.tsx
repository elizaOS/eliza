/**
 * Renders a JSON-Schema-described plugin config as a form: resolves the schema
 * into ordered fields (basic + advanced groups), evaluates per-field visibility,
 * delegates each field to `ConfigField` + the registry's renderer, and surfaces
 * a validation summary. Exposes an imperative `validateAll()` via
 * `ConfigRendererHandle` so a parent form can gate submission. Group icons and
 * plugin theme tokens style the output; secret reveal is delegated to the caller.
 */
import type React from "react";
import {
  forwardRef,
  useCallback,
  useImperativeHandle,
  useMemo,
  useState,
} from "react";
import type {
  FieldRegistry,
  FieldRenderer,
  FieldRenderProps,
  JsonSchemaObject,
  ResolvedField,
} from "../../config/config-catalog";
import {
  evaluateFieldVisibility,
  matchesSafeUntrustedRegexPattern,
  resolveFields,
  runValidation,
} from "../../config/config-catalog";
import { cn } from "../../lib/utils";
import { useAppSelector } from "../../state";
import type { ConfigUiHint, PluginUiTheme } from "../../types";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { Badge } from "../ui/badge";
import { Banner } from "../ui/banner";
import { Button } from "../ui/button";
import { Card, type CardProps } from "../ui/card";
import { Progress } from "../ui/progress";
import { Separator } from "../ui/separator";
import { ConfigField, type ConfigFieldLayout } from "./config-field";

// ── Props ──────────────────────────────────────────────────────────────

export interface ConfigRendererProps {
  /** JSON Schema describing the config structure (type: "object"). */
  schema: JsonSchemaObject | null;
  /** UI rendering hints keyed by property name. */
  hints?: Record<string, ConfigUiHint>;
  /** Current config values keyed by property name. */
  values?: Record<string, unknown>;
  /** Which keys currently have values set (for status dots). */
  setKeys?: Set<string>;
  /** Field registry (catalog + renderers + action handlers). */
  registry: FieldRegistry;
  /** Plugin ID (used for revealing sensitive values via API). */
  pluginId?: string;
  /** Callback to reveal a sensitive field's real value. */
  revealSecret?: (pluginId: string, key: string) => Promise<string | null>;
  /** Callback when a field value changes. */
  onChange?: (key: string, value: unknown) => void;
  /** Render function for each field — receives renderProps and the resolved renderer. */
  renderField?: (
    renderProps: FieldRenderProps,
    renderer: FieldRenderer,
  ) => React.ReactNode;
  /** Show a validation error summary above the form fields when errors exist. Defaults to true. */
  showValidationSummary?: boolean;
  /** Partial theme overrides for plugin UI tokens. */
  theme?: Partial<PluginUiTheme>;
  /**
   * `grid` (default) — multi-column field grid.
   * `rows` — one full-width settings row per field (label/help left, control
   * right), matching the Devin-style connector detail surface.
   */
  layout?: "grid" | "rows";
}

/** Handle exposed by ConfigRenderer via ref for parent-driven validation. */
export interface ConfigRendererHandle {
  /** Run validation on all visible fields. Returns true if the form is valid (no errors). */
  validateAll: () => boolean;
}

// ── Group icons ────────────────────────────────────────────────────────

const GROUP_ICONS: Record<string, string> = {
  // Auth & Security
  auth: "\u{1F511}",
  authentication: "\u{1F511}",
  security: "\u{1F6E1}\uFE0F",
  permissions: "\u{1F512}",
  "api keys": "\u{1F511}",
  // Connection & Network
  connection: "\u{1F517}",
  network: "\u{1F310}",
  api: "\u{1F50C}",
  webhook: "\u{1F4E1}",
  // Models & AI
  models: "\u{1F916}",
  model: "\u{1F916}",
  "ai models": "\u{1F916}",
  "text generation": "\u{1F916}",
  embeddings: "\u{1F9E0}",
  // Behavior & Config
  behavior: "\u2699\uFE0F",
  configuration: "\u2699\uFE0F",
  general: "\u2699\uFE0F",
  defaults: "\u2699\uFE0F",
  advanced: "\u{1F527}",
  features: "\u2728",
  // Time & Scheduling
  timing: "\u23F1\uFE0F",
  scheduling: "\u{1F4C5}",
  // Storage & Data
  storage: "\u{1F4BE}",
  bucket: "\u{1F4E6}",
  paths: "\u{1F4C2}",
  output: "\u{1F4E4}",
  repository: "\u{1F4DA}",
  // Communication
  messaging: "\u{1F4AC}",
  channels: "\u{1F4E2}",
  chatrooms: "\u{1F4AC}",
  voice: "\u{1F3A4}",
  speech: "\u{1F3A4}",
  "speech-to-text": "\u{1F3A4}",
  // Identity
  identity: "\u{1F464}",
  "client identity": "\u{1F464}",
  session: "\u{1F464}",
  // Display & Media
  display: "\u{1F3A8}",
  media: "\u{1F3AC}",
  // Notifications
  notifications: "\u{1F514}",
  logging: "\u{1F4DD}",
  // Finance & Trading
  trading: "\u{1F4C8}",
  "risk management": "\u{1F6E1}\uFE0F",
  wallet: "\u{1F4B0}",
  payment: "\u{1F4B3}",
  pricing: "\u{1F4B2}",
  // Blockchain
  blockchain: "\u26D3\uFE0F",
  ethereum: "\u26D3\uFE0F",
  solana: "\u26D3\uFE0F",
  base: "\u26D3\uFE0F",
  arbitrum: "\u26D3\uFE0F",
  bsc: "\u26D3\uFE0F",
  testnets: "\u{1F9EA}",
  "dex config": "\u{1F4CA}",
  // Social
  posting: "\u{1F4DD}",
  "x/twitter authentication": "\u{1F511}",
  "x/twitter behavior": "\u{1F426}",
  // System
  limits: "\u{1F4CF}",
  providers: "\u{1F50C}",
  commands: "\u2318",
  actions: "\u26A1",
  policies: "\u{1F4DC}",
  autonomy: "\u{1F916}",
  "background jobs": "\u{1F504}",
  "workflow connection": "\u{1F517}",
  app: "\u{1F4F1}",
};

function groupIcon(group: string): string {
  return GROUP_ICONS[group.toLowerCase()] ?? "\u25A0";
}

// ── Width → Tailwind column span ───────────────────────────────────────

function widthClass(width: "full" | "half" | "third"): string {
  switch (width) {
    case "half":
      return "col-span-6 sm:col-span-3";
    case "third":
      return "col-span-6 sm:col-span-2";
    default:
      return "col-span-6";
  }
}

// ── Validation Summary ─────────────────────────────────────────────────

interface ValidationSummaryProps {
  /** Map of field key to its error messages. */
  fieldErrors: Map<string, string[]>;
  /** Map of field key to its display label. */
  fieldLabels: Map<string, string>;
  /** Plugin ID for scoping field IDs. */
  pluginId?: string;
}

function ValidationSummary({
  fieldErrors,
  fieldLabels,
  pluginId,
}: ValidationSummaryProps) {
  const t = useAppSelector((s) => s.t);
  const errorEntries = [...fieldErrors.entries()].filter(
    ([, errors]) => errors.length > 0,
  );
  const totalErrors = errorEntries.length;

  if (totalErrors === 0) return null;

  const handleFieldClick = (key: string) => {
    const el = document.getElementById(
      pluginId ? `field-${pluginId}-${key}` : `field-${key}`,
    );
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  };

  return (
    <Alert variant="destructive" className="mb-4">
      <AlertTitle>
        {totalErrors} {totalErrors === 1 ? "field needs" : "fields need"}{" "}
        {t("config-renderer.attention", { defaultValue: "attention" })}
      </AlertTitle>
      <AlertDescription>
        <ul className="flex list-none flex-col gap-1 p-0">
          {errorEntries.map(([key]) => (
            <li key={key}>
              <Button
                type="button"
                variant="surfaceDestructive"
                size="content"
                align="start"
                onClick={() => handleFieldClick(key)}
              >
                <span className="opacity-60">
                  {t("config-renderer.Rarr", { defaultValue: "→" })}
                </span>
                <span>{fieldLabels.get(key) ?? key}</span>
              </Button>
            </li>
          ))}
        </ul>
      </AlertDescription>
    </Alert>
  );
}

// ── Theme mapping ──────────────────────────────────────────────────────

/** Maps PluginUiTheme keys to CSS variable names. */
const THEME_TO_CSS = {
  fieldGap: "--plugin-field-gap",
  groupGap: "--plugin-group-gap",
  sectionPadding: "--plugin-section-padding",
  labelSize: "--plugin-label-size",
  helpSize: "--plugin-help-size",
  errorSize: "--plugin-error-size",
  labelColor: "--plugin-label",
  helpColor: "--plugin-help",
  errorColor: "--plugin-error",
  borderColor: "--plugin-border",
  focusRing: "--plugin-focus-ring",
  inputHeight: "--plugin-input-height",
  maxFieldWidth: "--plugin-max-field-width",
} satisfies Record<keyof PluginUiTheme, `--${string}`>;

// ── Component ──────────────────────────────────────────────────────────

export const ConfigRenderer = forwardRef<
  ConfigRendererHandle,
  ConfigRendererProps
>(function ConfigRenderer(
  {
    schema,
    hints = {},
    values = {},
    setKeys = new Set(),
    registry,
    pluginId = "",
    revealSecret,
    onChange,
    renderField: renderFieldOverride,
    showValidationSummary = true,
    theme,
    layout = "grid",
  }: ConfigRendererProps,
  ref,
) {
  const fieldLayout: ConfigFieldLayout = layout === "rows" ? "row" : "stacked";
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Map<string, string[]>>(
    new Map(),
  );

  // ── Validation pipeline (4 stages) ──────────────────────────────────

  const validateField = useCallback(
    (field: ResolvedField, value: unknown): string[] => {
      const errors: string[] = [];

      // 1. Required check
      if (field.required && (value == null || value === "")) {
        errors.push("This field is required.");
      }

      // 2. Zod validation
      if (value != null && value !== "") {
        const result = registry.catalog.validate(field.fieldType, value);
        if (!result.success) {
          errors.push(...result.error.issues.map((i) => i.message));
        }
      }

      // 3. Pattern validation from hints
      if (field.hint.pattern && typeof value === "string" && value) {
        if (!matchesSafeUntrustedRegexPattern(field.hint.pattern, value)) {
          errors.push(field.hint.patternError ?? "Invalid format.");
        }
      }

      // 4. Declarative validation checks (json-render style)
      if (field.validation) {
        const checkResult = runValidation(
          field.validation,
          value,
          values,
          registry.catalog.functions,
        );
        if (!checkResult.valid) {
          errors.push(...checkResult.errors);
        }
      }

      return errors;
    },
    [registry, values],
  );

  // ── Visibility evaluation ────────────────────────────────────────────

  const isFieldVisible = useCallback(
    (field: ResolvedField): boolean => {
      // requires / requiresAny honor setKeys so masked secrets unlock
      // dependent fields (poll interval, channel lists, …) without echoing.
      return evaluateFieldVisibility({
        hidden: field.hidden,
        requires: field.requires,
        requiresAny: field.requiresAny,
        visible: field.visible,
        values,
        setKeys,
      });
    },
    [values, setKeys],
  );

  // ── Field change handler ─────────────────────────────────────────────

  const handleFieldChange = useCallback(
    (field: ResolvedField, value: unknown): void => {
      // Validate and store errors
      const errors = validateField(field, value);
      setFieldErrors((prev) => {
        const next = new Map(prev);
        if (errors.length > 0) {
          next.set(field.key, errors);
        } else {
          next.delete(field.key);
        }
        return next;
      });

      onChange?.(field.key, value);
    },
    [validateField, onChange],
  );

  // ── Action execution ─────────────────────────────────────────────────

  const executeAction = useCallback(
    async (
      action: string,
      params?: Record<string, unknown>,
    ): Promise<unknown> => {
      const handler = registry.resolveAction(action);
      if (!handler) {
        return undefined;
      }
      return handler(params ?? {}, values);
    },
    [registry, values],
  );

  // ── Build render props for a field ───────────────────────────────────

  const buildRenderProps = useCallback(
    (field: ResolvedField): FieldRenderProps => {
      const isSensitive = field.hint.sensitive === true;
      return {
        key: field.key,
        value: values[field.key],
        schema: field.schema,
        hint: field.hint,
        fieldType: field.fieldType,
        onChange: (value: unknown) => handleFieldChange(field, value),
        isSet: setKeys.has(field.key),
        required: field.required,
        errors: fieldErrors.get(field.key),
        readonly: field.readonly,
        onReveal:
          isSensitive && revealSecret && pluginId
            ? () => revealSecret(pluginId, field.key)
            : undefined,
        onAction: (action: string, params?: Record<string, unknown>) =>
          executeAction(action, params),
      };
    },
    [
      values,
      setKeys,
      fieldErrors,
      handleFieldChange,
      revealSecret,
      pluginId,
      executeAction,
    ],
  );

  // ── Render a single field ────────────────────────────────────────────

  const renderField = useCallback(
    (field: ResolvedField) => {
      const rp = buildRenderProps(field);
      const renderer = registry.resolveOrFallback(field.fieldType);
      // Rows layout always spans the full track — never pair two settings on
      // one horizontal line.
      const spanClass =
        layout === "rows" ? "col-span-6" : widthClass(field.width);

      if (renderFieldOverride) {
        return (
          <div key={field.key} className={spanClass}>
            {renderFieldOverride(rp, renderer)}
          </div>
        );
      }

      return (
        <div key={field.key} className={spanClass}>
          <ConfigField
            renderProps={rp}
            renderer={renderer}
            pluginId={pluginId}
            layout={fieldLayout}
          />
        </div>
      );
    },
    [
      buildRenderProps,
      registry,
      renderFieldOverride,
      pluginId,
      layout,
      fieldLayout,
    ],
  );

  // ── Resolve and partition fields ─────────────────────────────────────

  const { groups, advanced, showHeaders, allVisibleFields } = useMemo(() => {
    if (!schema)
      return {
        groups: new Map<string, ResolvedField[]>(),
        advanced: [] as ResolvedField[],
        showHeaders: false,
        allVisibleFields: [] as ResolvedField[],
      };

    const catalog = registry.catalog;
    const allFields = resolveFields(schema, hints, catalog);

    // Filter: hidden fields, showIf + rich visibility conditions
    const visibleFields = allFields.filter(isFieldVisible);

    const generalFields = visibleFields.filter((f) => !f.advanced);
    const advancedFields = visibleFields.filter((f) => f.advanced);

    // Group general fields, sort required-unconfigured to the top within each group.
    // Use setKeys (server-persisted state) instead of live `values` to decide
    // emptiness — otherwise typing into a field causes it to jump position
    // mid-keystroke as it transitions from "empty required" to "filled required".
    const fieldGroups = new Map<string, ResolvedField[]>();
    for (const f of generalFields) {
      const g = fieldGroups.get(f.group) ?? [];
      g.push(f);
      fieldGroups.set(f.group, g);
    }
    for (const [, fields] of fieldGroups) {
      fields.sort((a, b) => {
        const aEmpty = a.required && !setKeys.has(a.key);
        const bEmpty = b.required && !setKeys.has(b.key);
        if (aEmpty && !bEmpty) return -1;
        if (!aEmpty && bEmpty) return 1;
        return (a.hint.order ?? 999) - (b.hint.order ?? 999);
      });
    }

    return {
      groups: fieldGroups,
      advanced: advancedFields,
      showHeaders: fieldGroups.size > 1,
      allVisibleFields: visibleFields,
    };
  }, [schema, hints, registry, isFieldVisible, setKeys]);

  // ── Field labels for validation summary ────────────────────────────

  const fieldLabels = useMemo(() => {
    const labels = new Map<string, string>();
    for (const field of allVisibleFields) {
      labels.set(field.key, field.hint.label ?? field.key);
    }
    return labels;
  }, [allVisibleFields]);

  // ── Validate all visible fields ────────────────────────────────────

  const validateAll = useCallback((): boolean => {
    const nextErrors = new Map<string, string[]>();
    for (const field of allVisibleFields) {
      const errors = validateField(field, values[field.key]);
      if (errors.length > 0) {
        nextErrors.set(field.key, errors);
      }
    }
    setFieldErrors(nextErrors);
    return nextErrors.size === 0;
  }, [allVisibleFields, validateField, values]);

  // ── Expose validateAll to parent via ref ───────────────────────────

  useImperativeHandle(ref, () => ({ validateAll }), [validateAll]);

  // ── Configuration progress ─────────────────────────────────────────

  const configProgress = useMemo(() => {
    const total = allVisibleFields.length;
    if (total === 0) return null;
    const isConfigured = (f: ResolvedField) => {
      if (setKeys.has(f.key)) return true;
      const v = values[f.key];
      return v != null && v !== "";
    };
    const configured = allVisibleFields.filter(isConfigured).length;
    const requiredTotal = allVisibleFields.filter((f) => f.required).length;
    const requiredSet = allVisibleFields.filter(
      (f) => f.required && isConfigured(f),
    ).length;
    return { total, configured, requiredTotal, requiredSet };
  }, [allVisibleFields, values, setKeys]);

  // ── Theme style ────────────────────────────────────────────────────

  const themeStyle = useMemo(() => {
    if (!theme) return undefined;
    const style: NonNullable<CardProps["tokenStyle"]> = {};
    for (const [key, value] of Object.entries(theme)) {
      const cssVar = THEME_TO_CSS[key as keyof typeof THEME_TO_CSS];
      if (cssVar && value) {
        style[cssVar] = value;
      }
    }
    return Object.keys(style).length > 0 ? style : undefined;
  }, [theme]);

  // ── i18n ────────────────────────────────────────────────────────────
  const tFn = useAppSelector((s) => s.t);

  // ── Empty state ──────────────────────────────────────────────────────

  if (!schema) {
    return (
      <div className="text-xs text-muted italic py-3">
        {tFn("config-renderer.NoSchemaProvided")}
      </div>
    );
  }

  // ── Render ───────────────────────────────────────────────────────────

  return (
    <Card variant="transparentSquare" tokenStyle={themeStyle}>
      {/* Progress indicator */}
      {configProgress &&
        configProgress.requiredTotal > 0 &&
        configProgress.requiredSet < configProgress.requiredTotal && (
          <Banner variant="warning" className="mb-4">
            <div className="flex-1">
              <ConfigProgressText configProgress={configProgress} />
              <Progress
                aria-label="Required configuration progress"
                value={
                  (configProgress.requiredSet / configProgress.requiredTotal) *
                  100
                }
              />
            </div>
          </Banner>
        )}

      {showValidationSummary && fieldErrors.size > 0 ? (
        <ValidationSummary
          fieldErrors={fieldErrors}
          fieldLabels={fieldLabels}
          pluginId={pluginId}
        />
      ) : null}

      {[...groups.entries()].map(([group, fields], groupIndex) => (
        <div key={group} className={groupIndex > 0 ? "mt-5" : ""}>
          {showHeaders && (
            <div
              className={cn(
                "mb-3 flex items-center gap-2",
                layout === "rows" && "px-1",
              )}
            >
              <span className="text-base leading-none">{groupIcon(group)}</span>
              <span className="text-xs font-bold uppercase tracking-wider text-txt opacity-70">
                {group}
              </span>
              <Separator className="ml-1 flex-1" />
            </div>
          )}
          {layout === "rows" ? (
            <Card variant="panel" className="overflow-hidden">
              {fields.map((f) => renderField(f))}
            </Card>
          ) : (
            <div className="grid grid-cols-6 gap-x-5 gap-y-0">
              {fields.map((f) => renderField(f))}
            </div>
          )}
        </div>
      ))}

      {advanced.length > 0 && (
        <div className="mt-5 pt-4">
          <AdvancedSectionToggle
            advanced={advanced}
            advancedOpen={advancedOpen}
            setAdvancedOpen={setAdvancedOpen}
          />
          {advancedOpen &&
            (layout === "rows" ? (
              <Card
                variant="panel"
                className="mt-1 overflow-hidden animate-[cr-slide_var(--duration-normal,200ms)_ease]"
              >
                {advanced.map((f) => renderField(f))}
              </Card>
            ) : (
              <div className="grid grid-cols-6 gap-x-5 gap-y-0 pt-1 animate-[cr-slide_var(--duration-normal,200ms)_ease]">
                {advanced.map((f) => renderField(f))}
              </div>
            ))}
        </div>
      )}
    </Card>
  );
});

function ConfigProgressText({
  configProgress,
}: {
  configProgress: {
    requiredSet: number;
    requiredTotal: number;
    configured: number;
    total: number;
  };
}) {
  const t = useAppSelector((s) => s.t);
  return (
    <div className="flex items-center justify-between mb-1.5">
      <span className="text-xs font-semibold text-[var(--warning,#f39c12)]">
        {configProgress.requiredSet}/{configProgress.requiredTotal}{" "}
        {t("config-renderer.requiredFieldsConf", {
          defaultValue: "required fields configured",
        })}
      </span>
      <span className="text-xs-tight text-muted">
        {configProgress.configured}/{configProgress.total}{" "}
        {t("config-renderer.total", { defaultValue: "total" })}
      </span>
    </div>
  );
}

function AdvancedSectionToggle({
  advanced,
  advancedOpen,
  setAdvancedOpen,
}: {
  advanced: ResolvedField[];
  advancedOpen: boolean;
  setAdvancedOpen: React.Dispatch<React.SetStateAction<boolean>>;
}) {
  const t = useAppSelector((s) => s.t);
  return (
    <Button
      type="button"
      variant="ghost"
      size="content"
      className="group mb-3"
      onClick={() => setAdvancedOpen((prev) => !prev)}
    >
      <span
        className="inline-block text-2xs text-muted transition-transform duration-200 group-hover:text-txt"
        style={{ transform: advancedOpen ? "rotate(90deg)" : "none" }}
      >
        &#9654;
      </span>
      <span className="text-xs font-bold uppercase tracking-wider text-muted group-hover:text-txt transition-colors">
        {t("nav.advanced", { defaultValue: "Advanced" })}
      </span>
      <Badge variant="outline" size="microBold" tone="accent">
        {advanced.length}
      </Badge>
      <Separator className="ml-1 flex-1 opacity-50" />
    </Button>
  );
}
