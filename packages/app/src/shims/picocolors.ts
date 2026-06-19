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
