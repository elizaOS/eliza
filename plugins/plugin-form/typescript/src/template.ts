/**
 * @module template
 * @description Simple template resolution for form-controlled prompts
 */

import type { FormControl, FormSession } from "./types";

export type TemplateValues = Record<string, string>;

const TEMPLATE_PATTERN = /\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g;

export function buildTemplateValues(session: FormSession): TemplateValues {
  const values: TemplateValues = {};

  for (const [key, state] of Object.entries(session.fields)) {
    const value = state.value;
    if (typeof value === "string") {
      values[key] = value;
    } else if (typeof value === "number" || typeof value === "boolean") {
      values[key] = String(value);
    }
  }

  const context = session.context;
  if (context && typeof context === "object" && !Array.isArray(context)) {
    for (const [key, value] of Object.entries(context)) {
      if (typeof value === "string") {
        values[key] = value;
      } else if (typeof value === "number" || typeof value === "boolean") {
        values[key] = String(value);
      }
    }
  }

  return values;
}

export function renderTemplate(
  template: string | undefined,
  values: TemplateValues,
): string | undefined {
  if (!template) {
    return template;
  }

  return template.replace(TEMPLATE_PATTERN, (match, key) => {
    const replacement = values[key];
    return replacement !== undefined ? replacement : match;
  });
}

export function resolveControlTemplates(
  control: FormControl,
  values: TemplateValues,
): FormControl {
  const resolvedOptions = control.options?.map((option) => ({
    ...option,
    label: renderTemplate(option.label, values) ?? option.label,
    description: renderTemplate(option.description, values),
  }));

  const resolvedFields = control.fields?.map((field) =>
    resolveControlTemplates(field, values),
  );

  return {
    ...control,
    label: renderTemplate(control.label, values) ?? control.label,
    description: renderTemplate(control.description, values),
    askPrompt: renderTemplate(control.askPrompt, values),
    example: renderTemplate(control.example, values),
    extractHints: control.extractHints?.map(
      (hint) => renderTemplate(hint, values) ?? hint,
    ),
    options: resolvedOptions,
    fields: resolvedFields ?? control.fields,
  };
}
