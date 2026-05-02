/**
 * Shared plugin banner utilities.
 *
 * WHY: Multiple plugins want custom ANSI banners, but the hard part is not the
 * ASCII art itself. The tricky bits are terminal display width, full-width
 * Unicode, emoji/grapheme handling, and ANSI-safe truncation/padding. Centralize
 * those rules so plugins can focus on content and keep layout correct.
 */

import type { IAgentRuntime } from "../types/runtime";

// Note: regex captures ANSI codes for consistent banner formatting across plugins.

// Pattern for matching ANSI escape sequences (RegExp constructor avoids control-char-in-regex lint)
const ANSI_ESC = "\x1b";
function newAnsiPattern() {
	return new RegExp(`${ANSI_ESC}\\[[0-9;]*m`, "g");
}

export type BannerColors = {
	border: string;
	bright?: string;
	dim?: string;
	title?: string;
	name?: string;
	value?: string;
	custom?: string;
	default?: string;
	required?: string;
	reset?: string;
};

export interface PluginSetting {
	name: string;
	value: unknown;
	defaultValue?: unknown;
	sensitive?: boolean;
	required?: boolean;
}

export interface BannerOptions {
	pluginName: string;
	description?: string;
	settings: PluginSetting[];
	runtime: IAgentRuntime;
	headerLines?: string[];
	footerLines?: string[];
	width?: number;
	colors?: Partial<BannerColors>;
}

const DEFAULT_COLORS: BannerColors = {
	border: "\x1b[32m",
	bright: "\x1b[1m",
	dim: "\x1b[2m",
	title: "\x1b[92m",
	name: "\x1b[92m",
	value: "\x1b[97m",
	custom: "\x1b[92m",
	default: "\x1b[2m",
	required: "\x1b[91m",
	reset: "\x1b[0m",
};

export function stripAnsi(text: string): string {
	return text.replace(new RegExp(`${ANSI_ESC}\\[[0-9;]*m`, "g"), "");
}

/**
 * Check if a code point is full-width (two terminal columns).
 * Ported from the translate banner implementation.
 */
function isFullWidth(code: number): boolean {
	return (
		(code >= 0x1100 && code <= 0x115f) ||
		code === 0x231a ||
		code === 0x231b ||
		(code >= 0x23e9 && code <= 0x23f3) ||
		code === 0x23f0 ||
		code === 0x2614 ||
		code === 0x2615 ||
		(code >= 0x2648 && code <= 0x2653) ||
		code === 0x267f ||
		code === 0x2693 ||
		code === 0x26a1 ||
		code === 0x26aa ||
		code === 0x26ab ||
		code === 0x26bd ||
		code === 0x26be ||
		code === 0x26c4 ||
		code === 0x26c5 ||
		code === 0x26ce ||
		code === 0x26d4 ||
		code === 0x26ea ||
		code === 0x26f2 ||
		code === 0x26f3 ||
		code === 0x26f5 ||
		code === 0x26fa ||
		code === 0x26fd ||
		code === 0x2702 ||
		code === 0x2705 ||
		(code >= 0x2708 && code <= 0x270d) ||
		code === 0x270f ||
		code === 0x2712 ||
		code === 0x2714 ||
		code === 0x2716 ||
		code === 0x271d ||
		code === 0x2721 ||
		code === 0x2728 ||
		(code >= 0x2733 && code <= 0x2734) ||
		code === 0x2744 ||
		code === 0x2747 ||
		code === 0x274c ||
		code === 0x274e ||
		(code >= 0x2753 && code <= 0x2755) ||
		code === 0x2757 ||
		(code >= 0x2763 && code <= 0x2764) ||
		(code >= 0x2795 && code <= 0x2797) ||
		code === 0x27a1 ||
		code === 0x27b0 ||
		code === 0x27bf ||
		(code >= 0x2934 && code <= 0x2935) ||
		(code >= 0x2b05 && code <= 0x2b07) ||
		(code >= 0x2b1b && code <= 0x2b1c) ||
		code === 0x2b50 ||
		code === 0x2b55 ||
		code === 0x3030 ||
		code === 0x303d ||
		code === 0x3297 ||
		code === 0x3299 ||
		(code >= 0x2e80 && code <= 0x3247 && code !== 0x303f) ||
		(code >= 0x3250 && code <= 0x4dbf) ||
		(code >= 0x4e00 && code <= 0xa4c6) ||
		(code >= 0xa960 && code <= 0xa97c) ||
		(code >= 0xac00 && code <= 0xd7a3) ||
		(code >= 0xf900 && code <= 0xfaff) ||
		(code >= 0xfe10 && code <= 0xfe19) ||
		(code >= 0xfe30 && code <= 0xfe6b) ||
		(code >= 0xff01 && code <= 0xff60) ||
		(code >= 0xffe0 && code <= 0xffe6) ||
		(code >= 0x1f000 && code <= 0x1fbff) ||
		(code >= 0x20000 && code <= 0x323af)
	);
}

function graphemeWidth(grapheme: string): number {
	const code = grapheme.codePointAt(0) ?? 0;
	if (grapheme.length > 2) return 2;
	return isFullWidth(code) ? 2 : 1;
}

export function displayWidth(text: string): number {
	const stripped = stripAnsi(text);
	const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
	let width = 0;
	for (const { segment } of segmenter.segment(stripped)) {
		width += graphemeWidth(segment);
	}
	return width;
}

export function sliceByWidth(text: string, maxWidth: number): string {
	const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
	let result = "";
	let width = 0;
	let index = 0;

	while (index < text.length && width < maxWidth) {
		const remaining = text.slice(index);
		const ansiMatch = remaining.match(newAnsiPattern());
		if (ansiMatch && ansiMatch.index === 0) {
			result += ansiMatch[0];
			index += ansiMatch[0].length;
			continue;
		}

		// Extract text before any ANSI code to avoid segmenting ANSI sequences
		const nextAnsiIndex = ansiMatch ? ansiMatch.index : remaining.length;
		const textSegment = remaining.slice(0, nextAnsiIndex);

		for (const { segment } of segmenter.segment(textSegment)) {
			const graphemeCols = graphemeWidth(segment);
			if (width + graphemeCols > maxWidth) break;

			result += segment;
			index += segment.length;
			width += graphemeCols;
			break; // Only process first grapheme
		}
	}

	let remaining = text.slice(index);
	let trailingAnsi = remaining.match(newAnsiPattern());
	while (trailingAnsi && trailingAnsi.index === 0) {
		result += trailingAnsi[0];
		index += trailingAnsi[0].length;
		remaining = text.slice(index);
		trailingAnsi = remaining.match(newAnsiPattern());
	}

	return result;
}

export function padToWidth(text: string, width: number): string {
	const current = displayWidth(text);
	if (current >= width) return text;
	return text + " ".repeat(width - current);
}

export function lineToWidth(text: string, width: number): string {
	const current = displayWidth(text);
	if (current > width) return sliceByWidth(text, width);
	return text + " ".repeat(width - current);
}

export function maskSecret(value: string): string {
	if (!value) return "••••••••";
	if (value.length <= 8) return "••••••••";
	const maskedLength = Math.max(1, Math.min(12, value.length - 8));
	return `${value.slice(0, 4)}${"•".repeat(maskedLength)}${value.slice(-4)}`;
}

function formatValue(
	value: unknown,
	sensitive: boolean,
	maxLen: number,
): string {
	let formatted: string;
	if (value === undefined || value === null || value === "") {
		formatted = "(not set)";
	} else if (sensitive) {
		formatted = maskSecret(String(value));
	} else {
		formatted = String(value);
	}
	if (formatted.length > maxLen) {
		formatted = `${formatted.slice(0, maxLen - 3)}...`;
	}
	return formatted;
}

function isDefaultValue(value: unknown, defaultValue: unknown): boolean {
	if (value === undefined || value === null || value === "") return true;
	return defaultValue !== undefined && value === defaultValue;
}

export function renderBanner(options: BannerOptions): string {
	const {
		pluginName,
		settings,
		runtime,
		headerLines,
		footerLines,
		width = 78,
	} = options;
	const c = { ...DEFAULT_COLORS, ...options.colors };

	const top = `${c.border}${c.bright}╔${"═".repeat(width)}╗${c.reset}`;
	const mid = `${c.border}${c.bright}╠${"═".repeat(width)}╣${c.reset}`;
	const bot = `${c.border}${c.bright}╚${"═".repeat(width)}╝${c.reset}`;
	const row = (content: string) =>
		`${c.border}${c.bright}║${c.reset}${lineToWidth(content, width)}${c.border}${c.bright}║${c.reset}`;

	const lines: string[] = [""];
	lines.push(top);
	lines.push(
		row(
			` ${c.bright}Character: ${runtime.character?.name ?? "unknown"}${c.reset}`,
		),
	);
	lines.push(mid);

	if (headerLines && headerLines.length > 0) {
		for (const headerLine of headerLines) {
			lines.push(row(headerLine));
		}
	} else {
		const title = `[ ${pluginName} ]`;
		const titleWithBracketsWidth = displayWidth(`[ ${pluginName} ]`);
		const leftPad = Math.max(
			0,
			Math.floor((width - titleWithBracketsWidth) / 2),
		);
		const centered = `${" ".repeat(leftPad)}${title}`;
		lines.push(row(`${c.title}${centered}${c.reset}`));
		if (options.description) {
			lines.push(row(`${c.dim}${options.description}${c.reset}`));
		}
	}

	lines.push(mid);

	const nameWidth = 38;
	const valueWidth = 22;
	const statusWidth = 8;

	lines.push(
		row(
			` ${c.bright}${padToWidth("ENV VARIABLE", nameWidth)} ${padToWidth("VALUE", valueWidth)} ${padToWidth("STATUS", statusWidth)}${c.reset}`,
		),
	);
	lines.push(
		row(
			` ${c.dim}${"-".repeat(nameWidth)} ${"-".repeat(valueWidth)} ${"-".repeat(statusWidth)}${c.reset}`,
		),
	);

	for (const setting of settings) {
		const isSet =
			setting.value !== undefined &&
			setting.value !== null &&
			setting.value !== "";

		let icon: string;
		let status: string;
		if (!isSet && setting.required) {
			icon = `${c.required}◆${c.reset}`;
			status = `${c.required}REQUIRED${c.reset}`;
		} else if (!isSet) {
			icon = `${c.dim}○${c.reset}`;
			status = `${c.default}default${c.reset}`;
		} else if (isDefaultValue(setting.value, setting.defaultValue)) {
			icon = `${c.default}●${c.reset}`;
			status = `${c.default}default${c.reset}`;
		} else {
			icon = `${c.custom}✓${c.reset}`;
			status = `${c.custom}custom${c.reset}`;
		}

		const name = padToWidth(setting.name, nameWidth - 2);
		const value = padToWidth(
			formatValue(
				setting.value ?? setting.defaultValue,
				setting.sensitive ?? false,
				valueWidth,
			),
			valueWidth,
		);
		const statusCell = padToWidth(status, statusWidth);

		lines.push(
			row(
				` ${icon} ${c.name}${name}${c.reset} ${c.value}${value}${c.reset} ${statusCell}`,
			),
		);
	}

	if (footerLines && footerLines.length > 0) {
		lines.push(mid);
		for (const footerLine of footerLines) {
			lines.push(row(`${c.dim}${footerLine}${c.reset}`));
		}
	} else {
		lines.push(mid);
		lines.push(
			row(
				` ${c.dim}${c.custom}✓${c.dim} custom  ${c.default}●${c.dim} default  ○ unset  ${c.required}◆${c.dim} required      → Set in .env${c.reset}`,
			),
		);
	}

	lines.push(bot);
	lines.push("");

	return lines.join("\n");
}

export function printBanner(options: BannerOptions): void {
	console.log(renderBanner(options));
}
