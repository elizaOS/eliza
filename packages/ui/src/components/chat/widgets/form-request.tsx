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

import { type FormEvent, useCallback, useMemo, useState } from "react";
import {
  ConfigFieldErrors,
  getConfigInputClassName,
} from "../../config-ui/config-control-primitives";
import { runValidation } from "../../config-ui/ui-renderer";
import { Button } from "../../ui/button";
import { Checkbox } from "../../ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../ui/select";
import type { FormFieldSpec, FormRequestSpec } from "../message-form-parser";

export type { FormFieldSpec, FormRequestSpec };

/** Value emitted per field: string for text/number/select, boolean for checkbox. */
export type FormResultValue = string | boolean;

export type FormRequestProps = {
  form: FormRequestSpec;
  /** Receives the structured result keyed by field name. */
  onSubmit: (formId: string, values: Record<string, FormResultValue>) => void;
};

function initialValueFor(field: FormFieldSpec): FormResultValue {
  return field.type === "checkbox" ? false : "";
}

export function FormRequest({ form, onSubmit }: FormRequestProps) {
  const [values, setValues] = useState<Record<string, FormResultValue>>(() => {
    const initial: Record<string, FormResultValue> = {};
    for (const field of form.fields) {
      initial[field.name] = initialValueFor(field);
    }
    return initial;
  });
  const [errors, setErrors] = useState<Record<string, string[]>>({});
  const [submitted, setSubmitted] = useState(false);

  const requiredFields = useMemo(
    () => form.fields.filter((f) => f.required && f.type !== "checkbox"),
    [form.fields],
  );

  const setValue = useCallback((name: string, value: FormResultValue) => {
    setValues((prev) => ({ ...prev, [name]: value }));
  }, []);

  const validateField = useCallback(
    (field: FormFieldSpec, value: FormResultValue) => {
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
      setErrors((prev) => ({ ...prev, [field.name]: fieldErrors }));
    },
    [],
  );

  const handleSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (submitted) return;

      const nextErrors: Record<string, string[]> = {};
      for (const field of requiredFields) {
        const fieldErrors = runValidation(
          [
            {
              fn: "required",
              message: `${field.label ?? field.name} is required`,
            },
          ],
          values[field.name],
        );
        if (fieldErrors.length > 0) nextErrors[field.name] = fieldErrors;
      }
      setErrors(nextErrors);
      if (Object.keys(nextErrors).length > 0) return;

      setSubmitted(true);
      onSubmit(form.id, values);
    },
    [form.id, onSubmit, requiredFields, submitted, values],
  );

  return (
    <form
      data-testid="form-request"
      data-form-id={form.id}
      className="my-2 border border-border bg-card p-3 text-sm space-y-3"
      onSubmit={handleSubmit}
    >
      {form.title ? <div className="font-bold">{form.title}</div> : null}
      {form.description ? (
        <div className="text-xs text-muted">{form.description}</div>
      ) : null}

      {form.fields.map((field) => {
        const label = field.label ?? field.name;
        const fieldErrors = errors[field.name];
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
                checked={Boolean(values[field.name])}
                disabled={submitted}
                onCheckedChange={(checked) => setValue(field.name, !!checked)}
              />
              <span className="font-semibold">{label}</span>
            </label>
          );
        }
        if (field.type === "select") {
          const options = field.options ?? [];
          const current = String(values[field.name] ?? "");
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
        // text / number
        return (
          <div key={field.name} className="flex flex-col gap-1 text-xs">
            <span className="font-semibold">{label}</span>
            <input
              aria-label={label}
              className={getConfigInputClassName({
                density: "compact",
                hasError: !!fieldErrors?.length,
              })}
              type={field.type === "number" ? "number" : "text"}
              name={field.name}
              placeholder={field.placeholder ?? ""}
              value={String(values[field.name] ?? "")}
              disabled={submitted}
              required={field.required}
              onChange={(e) => setValue(field.name, e.currentTarget.value)}
              onBlur={() => validateField(field, values[field.name])}
            />
            <ConfigFieldErrors errors={fieldErrors} />
          </div>
        );
      })}

      <Button type="submit" size="sm" disabled={submitted}>
        {submitted ? "Submitted" : form.submitLabel}
      </Button>
    </form>
  );
}
