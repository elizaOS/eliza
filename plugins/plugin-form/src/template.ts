/**
 * @module template
 * @description Simple template resolution for form-controlled prompts.
 * Nested `fields` graphs are bounded before the walk so a hostile session
 * or LLM-authored form cannot stack-overflow the agent.
 */

import type { JsonValue } from "@elizaos/core";
import { assertFormControlGraph } from "./form-control-graph";
import type { FormControl, FormSession } from "./types";
import { formatValue } from "./validation";

export type TemplateValues = Record<string, string>;

const TEMPLATE_PATTERN = /\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g;

/**
 * Build `{{placeholder}}` values for a session.
 *
 * Resolved labels, descriptions, ask prompts and examples go into the model
 * context and into replies, so a sensitive control's value is masked here with
 * the same mask a filled field shows. Otherwise `{{pin}}` in an ask prompt
 * would echo the secret the display path deliberately hides.
 */
export function buildTemplateValues(
  session: FormSession,
  controls: readonly FormControl[],
): TemplateValues {
  const values: TemplateValues = {};
  const sensitiveControls = new Map(
    controls
      .filter((control) => control.sensitive)
      .map((control) => [control.key, control]),
  );
  const record = (key: string, value: unknown): void => {
    const sensitiveControl = sensitiveControls.get(key);
    if (sensitiveControl) {
      values[key] = formatValue(value as JsonValue, sensitiveControl);
      return;
    }
    if (typeof value === "string") {
      values[key] = value;
    } else if (typeof value === "number" || typeof value === "boolean") {
      values[key] = String(value);
    }
  };

  const context = session.context;
  if (context && typeof context === "object" && !Array.isArray(context)) {
    for (const [key, value] of Object.entries(context)) {
      record(key, value);
    }
  }

  for (const [key, state] of Object.entries(session.fields)) {
    record(key, state.value);
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
  assertFormControlGraph(control);
  return resolveControlTemplatesUnchecked(control, values);
}

function resolveControlTemplatesUnchecked(
  control: FormControl,
  values: TemplateValues,
): FormControl {
  const resolvedOptions = control.options?.map((option) => ({
    ...option,
    label: renderTemplate(option.label, values) ?? option.label,
    description: renderTemplate(option.description, values),
  }));

  const resolvedFields = control.fields?.map((field) =>
    resolveControlTemplatesUnchecked(field, values),
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
