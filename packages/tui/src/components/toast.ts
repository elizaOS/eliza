/**
 * Toast component for displaying temporary notifications.
 */

import type { Component } from "../tui.js";
import { visibleWidth } from "../utils.js";

/**
 * Toast severity levels.
 */
export type ToastType = "info" | "success" | "warning" | "error";

/**
 * Theme functions for Toast styling.
 */
export interface ToastTheme {
	/** Style function for info toasts */
	info: (text: string) => string;
	/** Style function for success toasts */
	success: (text: string) => string;
	/** Style function for warning toasts */
	warning: (text: string) => string;
	/** Style function for error toasts */
	error: (text: string) => string;
	/** Optional border character (default: "│") */
	borderChar?: string;
	/** Optional icon for each type */
	icons?: {
		info?: string;
		success?: string;
		warning?: string;
		error?: string;
	};
}

/**
 * Options for Toast configuration.
 */
export interface ToastOptions {
	/** Theme for styling the toast */
	theme?: ToastTheme;
	/** Toast type/severity (default: "info") */
	type?: ToastType;
	/** Whether to show an icon (default: true) */
	showIcon?: boolean;
	/** Whether to show a border (default: true) */
	showBorder?: boolean;
	/** Horizontal padding inside the toast (default: 1) */
	paddingX?: number;
}

/**
 * Default icons for each toast type.
 */
const DEFAULT_ICONS = {
	info: "ℹ",
	success: "✓",
	warning: "⚠",
	error: "✗",
};

/**
 * Default theme with no styling.
 */
const DEFAULT_THEME: ToastTheme = {
	info: (text: string) => text,
	success: (text: string) => text,
	warning: (text: string) => text,
	error: (text: string) => text,
	borderChar: "│",
	icons: DEFAULT_ICONS,
};

/**
 * Toast component for displaying temporary notification messages.
 *
 * Features:
 * - Multiple severity levels (info, success, warning, error)
 * - Optional icons
 * - Configurable border
 * - Theming support
 */
export class Toast implements Component {
	private message: string;
	private type: ToastType;
	private theme: ToastTheme;
	private showIcon: boolean;
	private showBorder: boolean;
	private paddingX: number;

	// Cache
	private cachedMessage?: string;
	private cachedType?: ToastType;
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(message: string, options: ToastOptions = {}) {
		this.message = message;
		this.type = options.type ?? "info";
		this.theme = options.theme ?? DEFAULT_THEME;
		this.showIcon = options.showIcon ?? true;
		this.showBorder = options.showBorder ?? true;
		this.paddingX = options.paddingX ?? 1;
	}

	setMessage(message: string): void {
		this.message = message;
		this.invalidate();
	}

	setType(type: ToastType): void {
		this.type = type;
		this.invalidate();
	}

	setTheme(theme: ToastTheme): void {
		this.theme = theme;
		this.invalidate();
	}

	invalidate(): void {
		this.cachedMessage = undefined;
		this.cachedType = undefined;
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	render(width: number): string[] {
		// Check cache
		if (
			this.cachedLines &&
			this.cachedMessage === this.message &&
			this.cachedType === this.type &&
			this.cachedWidth === width
		) {
			return this.cachedLines;
		}

		const styleFn = this.theme[this.type];
		const borderChar = this.theme.borderChar ?? "│";
		const icons = this.theme.icons ?? DEFAULT_ICONS;
		const icon = icons[this.type] ?? "";

		// Calculate content components
		const borderWidth = this.showBorder ? 2 : 0; // "│ " on left side
		const iconWidth = this.showIcon && icon ? visibleWidth(icon) + 1 : 0; // icon + space
		const paddingWidth = this.paddingX * 2;
		const contentWidth = Math.max(1, width - borderWidth - iconWidth - paddingWidth);

		// Build the content
		let content = this.message;
		if (content.length > contentWidth) {
			// Truncate with ellipsis
			content = content.slice(0, contentWidth - 1) + "…";
		}

		// Build prefix (icon + padding)
		const prefix = this.showIcon && icon ? `${icon} ` : "";

		// Build the line
		const innerContent = prefix + content;
		const innerPad = Math.max(0, width - borderWidth - paddingWidth - visibleWidth(innerContent));

		let line: string;
		if (this.showBorder) {
			const leftPad = " ".repeat(this.paddingX);
			const rightPad = " ".repeat(innerPad) + " ".repeat(this.paddingX);
			line = styleFn(`${borderChar}${leftPad}${innerContent}${rightPad}`);
		} else {
			const leftPad = " ".repeat(this.paddingX);
			const rightPad = " ".repeat(innerPad) + " ".repeat(this.paddingX);
			line = styleFn(`${leftPad}${innerContent}${rightPad}`);
		}

		const lines = [line];

		// Update cache
		this.cachedMessage = this.message;
		this.cachedType = this.type;
		this.cachedWidth = width;
		this.cachedLines = lines;

		return lines;
	}
}
