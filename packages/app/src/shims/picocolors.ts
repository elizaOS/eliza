/**
 * Browser-bundle shim aliased in place of `picocolors`. Terminal ANSI styling
 * is meaningless in the renderer, so every color/style function is a plain
 * String() passthrough, `isColorSupported` is false, and `createColors`
 * returns the same object. Preserves the picocolors call surface for
 * dependencies without emitting escape codes.
 */
const passthrough = (value: unknown): string => String(value);

const colors = {
  isColorSupported: false,
  reset: passthrough,
  bold: passthrough,
  dim: passthrough,
  italic: passthrough,
  underline: passthrough,
  inverse: passthrough,
  hidden: passthrough,
  strikethrough: passthrough,
  black: passthrough,
  red: passthrough,
  green: passthrough,
  yellow: passthrough,
  blue: passthrough,
  magenta: passthrough,
  cyan: passthrough,
  white: passthrough,
  gray: passthrough,
  bgBlack: passthrough,
  bgRed: passthrough,
  bgGreen: passthrough,
  bgYellow: passthrough,
  bgBlue: passthrough,
  bgMagenta: passthrough,
  bgCyan: passthrough,
  bgWhite: passthrough,
  createColors: () => colors,
};

export const createColors = colors.createColors;
export default colors;
