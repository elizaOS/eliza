/** Renders complete authored templates with unescaped bindings and deterministic example names. */

import {
  buildDeterministicSeed,
  getDeterministicNames,
  replaceIndexedNameTokens,
} from "@elizaos/common";
import Handlebars from "handlebars";

type TemplateType = string | ((params: { state: object }) => string);
interface PromptState {
  values: Record<string, unknown>;
  data?: Record<string, unknown>;
  [key: string]: unknown;
}
const COMPILED_TEMPLATE_CACHE = new Map<
  string,
  Handlebars.TemplateDelegate<Record<string, unknown>>
>();
const COMPILED_TEMPLATE_CACHE_LIMIT = 256;

/**
 * Convert all double-brace bindings in a Handlebars template
 * to triple-brace bindings, so the output is NOT HTML-escaped.
 *
 * - Ignores block/partial/comment tags that start with # / ! >.
 * - Ignores the else keyword.
 * - Ignores bindings that are already triple-braced.
 *
 * @param  tpl  Handlebars template source
 * @return      Transformed template
 */
function upgradeDoubleToTriple(tpl: string) {
  return tpl.replace(
    // ────────╮ negative-LB: not already "{{{"
    //          │   {{     ─ opening braces
    //          │    ╰──── negative-LA: not {, #, /, !, >
    //          ▼
    /(?<!{){{(?![{#/!>])([\s\S]*?)}}/g,
    (_match: string, inner: string) => {
      // keep the block keyword {{else}} unchanged
      if (inner.trim() === "else") return `{{${inner}}}`;
      return `{{{${inner}}}}`;
    },
  );
}

function getCompiledTemplate(
  template: string,
): Handlebars.TemplateDelegate<Record<string, unknown>> {
  // Key by the raw template. upgradeDoubleToTriple is a pure function, so the
  // raw string maps 1:1 to its upgraded form — keying on the raw template lets
  // a cache hit skip the regex transform entirely (it only runs on a miss).
  const cached = COMPILED_TEMPLATE_CACHE.get(template);
  if (cached) {
    return cached;
  }

  const upgraded = upgradeDoubleToTriple(template);
  const compiled = Handlebars.compile(upgraded);
  COMPILED_TEMPLATE_CACHE.set(template, compiled);
  if (COMPILED_TEMPLATE_CACHE.size > COMPILED_TEMPLATE_CACHE_LIMIT) {
    const oldestKey = COMPILED_TEMPLATE_CACHE.keys().next().value;
    if (typeof oldestKey === "string") {
      COMPILED_TEMPLATE_CACHE.delete(oldestKey);
    }
  }

  return compiled;
}

function resolvePromptSeed(
  stateLike: Record<string, unknown>,
  stateValues?: Record<string, unknown>,
  stateData?: Record<string, unknown>,
): string {
  const normalizeSeedValue = (value: unknown): string | number | undefined => {
    if (typeof value === "string" || typeof value === "number") {
      return value;
    }
    return undefined;
  };

  return buildDeterministicSeed(
    normalizeSeedValue(stateValues?.__conversationSeed),
    normalizeSeedValue(stateData?.__conversationSeed),
    normalizeSeedValue(stateLike.__conversationSeed),
    normalizeSeedValue(stateValues?.agentName),
    normalizeSeedValue(stateLike.agentName),
    normalizeSeedValue(stateLike.roomId),
    "prompt",
  );
}

/** Renders a flat prompt context without escaping or recursively expanding its values. */
export const composePrompt = ({
  state,
  template,
}: {
  state: { [key: string]: string };
  template: TemplateType;
}) => {
  const templateStr =
    typeof template === "function" ? template({ state }) : template;

  const rendered = getCompiledTemplate(templateStr)(state);

  const output = composeRandomUser(rendered, 10, resolvePromptSeed(state));
  return output;
};

/** Renders state values over top-level fields while retaining the original callback state. */
export const composePromptFromState = ({
  state,
  template,
}: {
  state: PromptState;
  template: TemplateType;
}) => {
  const templateStr =
    typeof template === "function" ? template({ state }) : template;

  // get any keys that are in state but are not named text, values or data
  const stateKeys = Object.keys(state);
  const filteredKeys = stateKeys.filter(
    (key) => !["text", "values", "data"].includes(key),
  );

  // this flattens out key/values in text/values/data
  const filteredState = filteredKeys.reduce(
    (acc: Record<string, unknown>, key) => {
      acc[key] = state[key];
      return acc;
    },
    {},
  );

  const context = { ...filteredState, ...state.values };

  const rendered = getCompiledTemplate(templateStr)(context);

  // and then we flat state.values again
  const output = composeRandomUser(
    rendered,
    10,
    resolvePromptSeed(filteredState, state.values, state.data),
  );
  return output;
};

/** Resolves deferred example-name placeholders using the stable conversation seed. */
const composeRandomUser = (
  template: string,
  length: number,
  seed = "prompt-users",
) => {
  // {{nameX}}/{{userX}} placeholders only appear in example-conversation
  // templates; production system/response templates have none. Skip the
  // deterministic-name generation entirely when no placeholder is present.
  if (!template.includes("{{name") && !template.includes("{{user")) {
    return template;
  }
  const exampleNames = getDeterministicNames(length, seed);
  return replaceIndexedNameTokens(template, exampleNames);
};
