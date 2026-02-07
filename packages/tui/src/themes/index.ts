/**
 * TUI Themes System
 *
 * Provides built-in color schemes and theming utilities.
 */

/**
 * Base colors that can be styled differently by each theme.
 */
export interface ThemeColors {
	// Primary/accent colors
	primary: (text: string) => string;
	secondary: (text: string) => string;
	accent: (text: string) => string;

	// Status colors
	success: (text: string) => string;
	warning: (text: string) => string;
	error: (text: string) => string;
	info: (text: string) => string;

	// Text colors
	text: (text: string) => string;
	textMuted: (text: string) => string;
	textBold: (text: string) => string;

	// Background colors
	background: (text: string) => string;
	backgroundAlt: (text: string) => string;

	// Border colors
	border: (text: string) => string;
	borderFocused: (text: string) => string;
}

/**
 * A complete theme definition.
 */
export interface Theme {
	/** Theme name */
	name: string;
	/** Theme description */
	description?: string;
	/** Color palette */
	colors: ThemeColors;
}

// ANSI color code helpers
const ansi = {
	// Reset
	reset: "\x1b[0m",

	// Styles
	bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
	dim: (text: string) => `\x1b[2m${text}\x1b[22m`,
	italic: (text: string) => `\x1b[3m${text}\x1b[23m`,
	underline: (text: string) => `\x1b[4m${text}\x1b[24m`,

	// Basic colors (foreground)
	black: (text: string) => `\x1b[30m${text}\x1b[39m`,
	red: (text: string) => `\x1b[31m${text}\x1b[39m`,
	green: (text: string) => `\x1b[32m${text}\x1b[39m`,
	yellow: (text: string) => `\x1b[33m${text}\x1b[39m`,
	blue: (text: string) => `\x1b[34m${text}\x1b[39m`,
	magenta: (text: string) => `\x1b[35m${text}\x1b[39m`,
	cyan: (text: string) => `\x1b[36m${text}\x1b[39m`,
	white: (text: string) => `\x1b[37m${text}\x1b[39m`,
	gray: (text: string) => `\x1b[90m${text}\x1b[39m`,

	// Bright colors (foreground)
	brightRed: (text: string) => `\x1b[91m${text}\x1b[39m`,
	brightGreen: (text: string) => `\x1b[92m${text}\x1b[39m`,
	brightYellow: (text: string) => `\x1b[93m${text}\x1b[39m`,
	brightBlue: (text: string) => `\x1b[94m${text}\x1b[39m`,
	brightMagenta: (text: string) => `\x1b[95m${text}\x1b[39m`,
	brightCyan: (text: string) => `\x1b[96m${text}\x1b[39m`,
	brightWhite: (text: string) => `\x1b[97m${text}\x1b[39m`,

	// Background colors
	bgBlack: (text: string) => `\x1b[40m${text}\x1b[49m`,
	bgRed: (text: string) => `\x1b[41m${text}\x1b[49m`,
	bgGreen: (text: string) => `\x1b[42m${text}\x1b[49m`,
	bgYellow: (text: string) => `\x1b[43m${text}\x1b[49m`,
	bgBlue: (text: string) => `\x1b[44m${text}\x1b[49m`,
	bgMagenta: (text: string) => `\x1b[45m${text}\x1b[49m`,
	bgCyan: (text: string) => `\x1b[46m${text}\x1b[49m`,
	bgWhite: (text: string) => `\x1b[47m${text}\x1b[49m`,
	bgGray: (text: string) => `\x1b[100m${text}\x1b[49m`,

	// 256-color support
	fg256: (code: number) => (text: string) => `\x1b[38;5;${code}m${text}\x1b[39m`,
	bg256: (code: number) => (text: string) => `\x1b[48;5;${code}m${text}\x1b[49m`,

	// True color (24-bit) support
	fgRgb: (r: number, g: number, b: number) => (text: string) => `\x1b[38;2;${r};${g};${b}m${text}\x1b[39m`,
	bgRgb: (r: number, g: number, b: number) => (text: string) => `\x1b[48;2;${r};${g};${b}m${text}\x1b[49m`,
};

// Compose multiple style functions
const compose =
	(...fns: Array<(text: string) => string>) =>
	(text: string) =>
		fns.reduce((t, fn) => fn(t), text);

/** Identity function for no-op styling */
const identity = (text: string): string => text;

/**
 * Default theme with standard terminal colors.
 */
export const defaultTheme: Theme = {
	name: "default",
	description: "Standard terminal colors",
	colors: {
		primary: ansi.cyan,
		secondary: ansi.blue,
		accent: ansi.magenta,

		success: ansi.green,
		warning: ansi.yellow,
		error: ansi.red,
		info: ansi.cyan,

		text: identity,
		textMuted: ansi.gray,
		textBold: ansi.bold,

		background: identity,
		backgroundAlt: ansi.bgGray,

		border: ansi.gray,
		borderFocused: ansi.cyan,
	},
};

/**
 * Dark theme with deeper colors.
 */
export const darkTheme: Theme = {
	name: "dark",
	description: "Dark theme with deep colors",
	colors: {
		primary: ansi.brightCyan,
		secondary: ansi.brightBlue,
		accent: ansi.brightMagenta,

		success: ansi.brightGreen,
		warning: ansi.brightYellow,
		error: ansi.brightRed,
		info: ansi.brightCyan,

		text: ansi.white,
		textMuted: ansi.gray,
		textBold: compose(ansi.white, ansi.bold),

		background: ansi.bgBlack,
		backgroundAlt: ansi.bgGray,

		border: ansi.gray,
		borderFocused: ansi.brightCyan,
	},
};

/**
 * Minimal theme with subtle styling.
 */
export const minimalTheme: Theme = {
	name: "minimal",
	description: "Minimal theme with subtle styling",
	colors: {
		primary: ansi.white,
		secondary: ansi.gray,
		accent: ansi.white,

		success: ansi.green,
		warning: ansi.yellow,
		error: ansi.red,
		info: ansi.gray,

		text: identity,
		textMuted: ansi.dim,
		textBold: ansi.bold,

		background: identity,
		backgroundAlt: identity,

		border: ansi.gray,
		borderFocused: ansi.white,
	},
};

/**
 * Ocean theme with blue tones.
 */
export const oceanTheme: Theme = {
	name: "ocean",
	description: "Ocean-inspired blue tones",
	colors: {
		primary: ansi.fg256(39),
		secondary: ansi.fg256(75),
		accent: ansi.fg256(45),

		success: ansi.fg256(42),
		warning: ansi.fg256(214),
		error: ansi.fg256(203),
		info: ansi.fg256(39),

		text: ansi.fg256(255),
		textMuted: ansi.fg256(245),
		textBold: compose(ansi.fg256(255), ansi.bold),

		background: ansi.bg256(17),
		backgroundAlt: ansi.bg256(24),

		border: ansi.fg256(39),
		borderFocused: ansi.fg256(45),
	},
};

/**
 * Available built-in themes.
 */
export const themes = {
	default: defaultTheme,
	dark: darkTheme,
	minimal: minimalTheme,
	ocean: oceanTheme,
} as const;

export function getTheme(name: keyof typeof themes): Theme {
	return themes[name];
}

/**
 * Export ANSI helpers for custom theme creation.
 */
export { ansi, compose };
