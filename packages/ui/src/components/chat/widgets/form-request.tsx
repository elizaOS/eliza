/**
 * FormRequest — generic in-chat form for `[FORM]` blocks emitted by agent
 * actions. Distinct from the secret form (`SensitiveRequestBlock`, driven by
 * `message.secretRequest`): this is for non-sensitive structured input.
 *
 * The fields reuse the config-ui control primitives + the shared
 * `runValidation` runner (the same building blocks `UiRenderer` uses for its
 * Input/Select/Checkbox), so styling and required-validation stay consistent
 * with the GenUI/config form path rather than duplicating it. On submit the
 * structured result is handed to `onSubmit` (the host sends it back as a
 * message), matching the existing message-action callback wiring.
 */

import { type FormEvent, memo, useCallback, useMemo, useState } from "react";
import { ConfigFieldErrors } from "../../config-ui/config-control-primitives";
import { getConfigInputClassName } from "../../config-ui/config-control-primitives.helpers";
import { runValidation } from "../../config-ui/ui-renderer.helpers";
import { Button } from "../../ui/button";
import { Checkbox } from "../../ui/checkbox";
import { Input } from "../../ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../ui/select";
import type { FormFieldSpec, FormRequestSpec } from "../message-form-parser";
import { ChatWidgetShell } from "./chat-widget-shell";
import { formRequestPropsEqual } from "./widget-equality";

export type { FormFieldSpec, FormRequestSpec };

/** Value emitted per field: string for text/number/select, boolean for checkbox. */
export type FormResultValue = string | boolean;

/**
 * Map a form field type to the `<input type>` used for the text-like branch
 * (checkbox and select render their own controls). The temporal types delegate
 * to the browser's native pickers — `date` → `YYYY-MM-DD`, `time` → `HH:mm`,
 * `datetime` → `<input type="datetime-local">` yielding `YYYY-MM-DDTHH:mm` —
 * so no custom picker or dependency is added. Any other type is a plain text
 * box. Exported for the field-type unit test.
 */
export function htmlInputTypeForField(
  fieldType: FormFieldSpec["type"],
): string {
  switch (fieldType) {
    case "number":
      return "number";
    case "date":
      return "date";
    case "time":
      return "time";
    case "datetime":
      return "datetime-local";
    default:
      return "text";
  }
}

export type FormRequestProps = {
  form: FormRequestSpec;
  /** Receives the structured result keyed by field name. */
  onSubmit: (formId: string, values: Record<string, FormResultValue>) => void;
};

type FormValueRecord = Record<string, FormResultValue>;
type FormErrorRecord = Record<string, string[]>;

function initialValueFor(field: FormFieldSpec): FormResultValue {
  return field.type === "checkbox" ? false : "";
}

function createFormRecord<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}

function copyFormRecord<T>(record: Record<string, T>): Record<string, T> {
  return Object.assign(createFormRecord<T>(), record);
}

function getOwnRecordValue<T>(
  record: Record<string, T>,
  name: string,
): T | undefined {
  return Object.hasOwn(record, name) ? record[name] : undefined;
}

function toSubmitPayload(values: FormValueRecord): FormValueRecord {
  return copyFormRecord(values);
}

// Memoized on the form spec by value (see `formRequestPropsEqual`). This widget
// holds user-entered field state internally, so it MUST survive the per-token
// re-parse of the surrounding message: a referential-only memo would see a
// fresh `form` object each streamed token and remount, wiping half-filled
// inputs mid-conversation.
export const FormRequest = memo(function FormRequest({
  form,
  onSubmit,
}: FormRequestProps) {
  const [values, setValues] = useState<FormValueRecord>(() => {
    const initial = createFormRecord<FormResultValue>();
    for (const field of form.fields) {
      initial[field.name] = initialValueFor(field);
    }
    return initial;
  });
  const [errors, setErrors] = useState<FormErrorRecord>(() =>
    createFormRecord<string[]>(),
  );
  const [submitted, setSubmitted] = useState(false);

  const requiredFields = useMemo(
    () => form.fields.filter((f) => f.required && f.type !== "checkbox"),
    [form.fields],
  );

  const setValue = useCallback((name: string, value: FormResultValue) => {
    setValues((prev) => {
      const next = copyFormRecord(prev);
      next[name] = value;
      return next;
    });
  }, []);

  const validateField = useCallback(
    (field: FormFieldSpec, value: FormResultValue | undefined) => {
      if (!field.required || field.type === "checkbox") return;
      const fieldErrors = runValidation(
        [
          {
            fn: "required",
            message: `${field.label ?? field.name} is required`,
          },
        ],
        value,
      );
      setErrors((prev) => {
        const next = copyFormRecord(prev);
        next[field.name] = fieldErrors;
        return next;
      });
    },
    [],
  );

  const handleSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (submitted) return;

      const nextErrors = createFormRecord<string[]>();
      for (const field of requiredFields) {
        const fieldErrors = runValidation(
          [
            {
              fn: "required",
              message: `${field.label ?? field.name} is required`,
            },
          ],
          getOwnRecordValue(values, field.name),
        );
        if (fieldErrors.length > 0) nextErrors[field.name] = fieldErrors;
      }
      setErrors(nextErrors);
      if (Object.keys(nextErrors).length > 0) return;

      setSubmitted(true);
      onSubmit(form.id, toSubmitPayload(values));
    },
    [form.id, onSubmit, requiredFields, submitted, values],
  );

  return (
    <ChatWidgetShell
      title={form.title ?? "Form"}
      status={
        <span className="text-[11px] font-medium text-muted">
          {submitted ? "Submitted" : `${form.fields.length} fields`}
        </span>
      }
      summary={submitted ? `${form.title ?? "Form"} submitted` : undefined}
      complete={submitted}
      testId="form-request-shell"
    >
      <form
        data-testid="form-request"
        data-form-id={form.id}
        className="space-y-3 py-1.5 text-sm"
        onSubmit={handleSubmit}
      >
        {form.description ? (
          <div className="text-xs text-txt/80">{form.description}</div>
        ) : null}

        {form.fields.map((field) => {
          const label = field.label ?? field.name;
          const value = getOwnRecordValue(values, field.name);
          const fieldErrors = getOwnRecordValue(errors, field.name);
          if (field.type === "checkbox") {
            const checkboxId = `${form.id}-${field.name}`;
            return (
              <label
                key={field.name}
                htmlFor={checkboxId}
                className="flex items-center gap-2 text-xs cursor-pointer"
              >
                <Checkbox
                  id={checkboxId}
                  checked={Boolean(value)}
                  disabled={submitted}
                  onCheckedChange={(checked) => setValue(field.name, !!checked)}
                />
                <span className="font-semibold">{label}</span>
              </label>
            );
          }
          if (field.type === "select") {
            const options = field.options ?? [];
            const current = String(value ?? "");
            return (
              <div key={field.name} className="flex flex-col gap-1 text-xs">
                <span className="font-semibold">{label}</span>
                <Select
                  value={current || "__none__"}
                  disabled={submitted}
                  onValueChange={(v) => {
                    const next = v === "__none__" ? "" : v;
                    setValue(field.name, next);
                    validateField(field, next);
                  }}
                >
                  <SelectTrigger
                    className={getConfigInputClassName({
                      density: "compact",
                      hasError: !!fieldErrors?.length,
                      className: "text-txt placeholder:text-txt/70",
                    })}
                    aria-label={label}
                  >
                    <SelectValue placeholder={field.placeholder ?? undefined} />
                  </SelectTrigger>
                  <SelectContent>
                    {field.placeholder ? (
                      <SelectItem value="__none__">
                        {field.placeholder}
                      </SelectItem>
                    ) : null}
                    {options
                      .filter((o) => o.value !== "")
                      .map((o) => (
                        <SelectItem key={o.value} value={o.value}>
                          {o.label}
                        </SelectItem>
                      ))}
                  </SelectContent>
                </Select>
                <ConfigFieldErrors errors={fieldErrors} />
              </div>
            );
          }
          // text / number / date / time / datetime (native inputs)
          return (
            <div key={field.name} className="flex flex-col gap-1 text-xs">
              <span className="font-semibold">{label}</span>
              <Input
                aria-label={label}
                className={getConfigInputClassName({
                  density: "compact",
                  hasError: !!fieldErrors?.length,
                  className: "text-txt placeholder:text-txt/70",
                })}
                type={htmlInputTypeForField(field.type)}
                name={field.name}
                placeholder={field.placeholder ?? ""}
                value={String(value ?? "")}
                disabled={submitted}
                required={field.required}
                onChange={(e) => setValue(field.name, e.currentTarget.value)}
                onBlur={() =>
                  validateField(field, getOwnRecordValue(values, field.name))
                }
              />
              <ConfigFieldErrors errors={fieldErrors} />
            </div>
          );
        })}

        <Button
          type="submit"
          size="sm"
          disabled={submitted}
          className="bg-[color-mix(in_srgb,var(--accent)_70%,black)] text-accent-fg hover:bg-[color-mix(in_srgb,var(--accent)_60%,black)]"
        >
          {submitted ? "Submitted" : form.submitLabel}
        </Button>
      </form>
    </ChatWidgetShell>
  );
}, formRequestPropsEqual);
