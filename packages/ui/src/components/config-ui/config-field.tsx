import type {
  FieldRenderer,
  FieldRenderProps,
} from "../../config/config-catalog";
import { useApp } from "../../state";
import { defaultRenderers } from "./config-field.helpers";

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
