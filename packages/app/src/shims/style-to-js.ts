/**
 * Browser shim for the `style-to-js` npm package used by the app bundle.
 * Converts a raw CSS inline-style string into a React-compatible style object,
 * camelCasing property names (honoring vendor prefixes and the `reactCompat`
 * `-ms-` special case) and leaving CSS custom properties (`--foo`) untouched.
 * Declaration and property/value splitting are quote- and paren-aware so
 * `url(...)`, `calc(...)`, and quoted values survive `;`/`:` inside them.
 * Exposes the callable `StyleToJS` as both named and default export.
 */
const CUSTOM_PROPERTY_REGEX = /^--[a-zA-Z0-9_-]+$/;
const HYPHEN_REGEX = /-([a-z])/g;
const NO_HYPHEN_REGEX = /^[^-]+$/;
const VENDOR_PREFIX_REGEX = /^-(webkit|moz|ms|o|khtml)-/;
const MS_VENDOR_PREFIX_REGEX = /^-(ms)-/;

export interface StyleToJSOptions {
  reactCompat?: boolean;
}

export type StyleObject = Record<string, string>;

interface StyleToJSFunction {
  (style: string, options?: StyleToJSOptions): StyleObject;
  default?: StyleToJSFunction;
}

function skipCamelCase(property: string): boolean {
  return (
    !property ||
    NO_HYPHEN_REGEX.test(property) ||
    CUSTOM_PROPERTY_REGEX.test(property)
  );
}

function camelCase(property: string, options: StyleToJSOptions = {}): string {
  if (skipCamelCase(property)) {
    return property;
  }

  let nextProperty = property.toLowerCase();
  nextProperty = options.reactCompat
    ? nextProperty.replace(MS_VENDOR_PREFIX_REGEX, (_match, prefix) => {
        return `${prefix}-`;
      })
    : nextProperty.replace(VENDOR_PREFIX_REGEX, (_match, prefix) => {
        return `${prefix}-`;
      });

  return nextProperty.replace(HYPHEN_REGEX, (_match, character) => {
    return character.toUpperCase();
  });
}

function splitDeclarations(style: string): string[] {
  const declarations: string[] = [];
  let start = 0;
  let quote: string | null = null;
  let parenDepth = 0;

  for (let index = 0; index < style.length; index += 1) {
    const character = style[index];
    const previous = style[index - 1];

    if (quote) {
      if (character === quote && previous !== "\\") {
        quote = null;
      }
      continue;
    }

    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }

    if (character === "(") {
      parenDepth += 1;
      continue;
    }

    if (character === ")" && parenDepth > 0) {
      parenDepth -= 1;
      continue;
    }

    if (character === ";" && parenDepth === 0) {
      declarations.push(style.slice(start, index));
      start = index + 1;
    }
  }

  declarations.push(style.slice(start));
  return declarations;
}

function splitPropertyValue(declaration: string): [string, string] | null {
  let quote: string | null = null;
  let parenDepth = 0;

  for (let index = 0; index < declaration.length; index += 1) {
    const character = declaration[index];
    const previous = declaration[index - 1];

    if (quote) {
      if (character === quote && previous !== "\\") {
        quote = null;
      }
      continue;
    }

    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }

    if (character === "(") {
      parenDepth += 1;
      continue;
    }

    if (character === ")" && parenDepth > 0) {
      parenDepth -= 1;
      continue;
    }

    if (character === ":" && parenDepth === 0) {
      const property = declaration.slice(0, index).trim();
      const value = declaration.slice(index + 1).trim();
      return property && value ? [property, value] : null;
    }
  }

  return null;
}

const StyleToJS: StyleToJSFunction = (style, options = {}) => {
  const output: StyleObject = {};
  if (!style || typeof style !== "string") {
    return output;
  }

  for (const declaration of splitDeclarations(style)) {
    const pair = splitPropertyValue(declaration);
    if (pair) {
      output[camelCase(pair[0], options)] = pair[1];
    }
  }

  return output;
};

StyleToJS.default = StyleToJS;

export { StyleToJS };
export default StyleToJS;
