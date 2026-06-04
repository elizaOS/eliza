const COMMENT_RE = /\/\*[^*]*\*+(?:[^/*][^*]*\*+)*\//g;
const CUSTOM_PROPERTY_RE = /^--[a-zA-Z0-9_-]+$/;
const HYPHEN_RE = /-([a-z])/g;
const NO_HYPHEN_RE = /^[^-]+$/;
const VENDOR_PREFIX_RE = /^-(webkit|moz|ms|o|khtml)-/;
const MS_VENDOR_PREFIX_RE = /^-(ms)-/;

export interface StyleToJSOptions {
  reactCompat?: boolean;
}

export type StyleObject = Record<string, string>;

interface StyleToJSFunction {
  (style: string, options?: StyleToJSOptions): StyleObject;
  default?: StyleToJSFunction;
}

function camelCase(property: string, options: StyleToJSOptions): string {
  if (
    !property ||
    NO_HYPHEN_RE.test(property) ||
    CUSTOM_PROPERTY_RE.test(property)
  ) {
    return property;
  }

  let normalized = property.toLowerCase();
  normalized = options.reactCompat
    ? normalized.replace(
        MS_VENDOR_PREFIX_RE,
        (_match, prefix: string) => `${prefix}-`,
      )
    : normalized.replace(
        VENDOR_PREFIX_RE,
        (_match, prefix: string) => `${prefix}-`,
      );

  return normalized.replace(HYPHEN_RE, (_match, character: string) =>
    character.toUpperCase(),
  );
}

function findDelimiter(input: string, delimiter: string): number {
  let quote: string | null = null;
  let escaped = false;
  let depth = 0;

  for (let index = 0; index < input.length; index += 1) {
    const character = input[index];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (character === "\\") {
      escaped = true;
      continue;
    }

    if (quote) {
      if (character === quote) quote = null;
      continue;
    }

    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }

    if (character === "(") {
      depth += 1;
      continue;
    }

    if (character === ")") {
      depth = Math.max(0, depth - 1);
      continue;
    }

    if (depth === 0 && character === delimiter) {
      return index;
    }
  }

  return -1;
}

function splitDeclarations(style: string): string[] {
  const declarations: string[] = [];
  let rest = style.replace(COMMENT_RE, "");

  while (rest.length > 0) {
    const index = findDelimiter(rest, ";");
    const declaration = index === -1 ? rest : rest.slice(0, index);
    if (declaration.trim()) declarations.push(declaration);
    if (index === -1) break;
    rest = rest.slice(index + 1);
  }

  return declarations;
}

export const StyleToJS: StyleToJSFunction = (style, options = {}) => {
  const output: StyleObject = {};
  if (!style || typeof style !== "string") return output;

  for (const declaration of splitDeclarations(style)) {
    const index = findDelimiter(declaration, ":");
    if (index === -1) continue;

    const property = declaration.slice(0, index).trim();
    const value = declaration.slice(index + 1).trim();
    if (property && value) {
      output[camelCase(property, options)] = value;
    }
  }

  return output;
};

export function styleToJs(
  style: string,
  options: StyleToJSOptions = {},
): StyleObject {
  return StyleToJS(style, options);
}

StyleToJS.default = StyleToJS;

export default StyleToJS;
