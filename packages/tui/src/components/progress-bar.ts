/**
 * ProgressBar component for displaying progress indicators.
 */

import type { Component } from "../tui.js";
import { visibleWidth } from "../utils.js";

/**
 * Theme functions for ProgressBar styling.
 */
export interface ProgressBarTheme {
	/** Style function for the filled portion of the bar */
	filled: (text: string) => string;
	/** Style function for the empty portion of the bar */
	empty: (text: string) => string;
	/** Style function for the percentage label */
	label?: (text: string) => string;
	/** Style function for the optional message */
	message?: (text: string) => string;
}

/**
 * Options for ProgressBar configuration.
 */
export interface ProgressBarOptions {
	/** Theme for styling the progress bar */
	theme?: ProgressBarTheme;
	/** Character to use for the filled portion (default: "█") */
	filledChar?: string;
	/** Character to use for the empty portion (default: "░") */
	emptyChar?: string;
	/** Whether to show percentage label (default: true) */
	showPercentage?: boolean;
	/** Optional message to display */
	message?: string;
	/** Horizontal padding (default: 0) */
	paddingX?: number;
	/** Width of the bar portion (default: auto-calculate) */
	barWidth?: number;
}

/**
 * Default theme with no styling.
 */
const DEFAULT_THEME: ProgressBarTheme = {
	filled: (text: string) => text,
	empty: (text: string) => text,
	label: (text: string) => text,
	message: (text: string) => text,
};

/**
 * ProgressBar component that displays a visual progress indicator.
 *
 * Features:
 * - Configurable filled/empty characters
 * - Optional percentage label
 * - Optional message
 * - Theming support
 */
export class ProgressBar implements Component {
	private progress: number; // 0-1 range
	private theme: ProgressBarTheme;
	private filledChar: string;
	private emptyChar: string;
	private showPercentage: boolean;
	private message?: string;
	private paddingX: number;
	private barWidth?: number;

	// Cache
	private cachedProgress?: number;
	private cachedWidth?: number;
	private cachedMessage?: string;
	private cachedLines?: string[];

	constructor(progress = 0, options: ProgressBarOptions = {}) {
		this.progress = Math.max(0, Math.min(1, progress));
		this.theme = options.theme ?? DEFAULT_THEME;
		this.filledChar = options.filledChar ?? "█";
		this.emptyChar = options.emptyChar ?? "░";
		this.showPercentage = options.showPercentage ?? true;
		this.message = options.message;
		this.paddingX = options.paddingX ?? 0;
		this.barWidth = options.barWidth;
	}

	setProgress(progress: number): void {
		this.progress = Math.max(0, Math.min(1, progress));
		this.invalidate();
	}

	getProgress(): number {
		return this.progress;
	}

	setMessage(message?: string): void {
		this.message = message;
		this.invalidate();
	}

	setTheme(theme: ProgressBarTheme): void {
		this.theme = theme;
		this.invalidate();
	}

	invalidate(): void {
		this.cachedProgress = undefined;
		this.cachedWidth = undefined;
		this.cachedMessage = undefined;
		this.cachedLines = undefined;
	}

	render(width: number): string[] {
		// Check cache
		if (
			this.cachedLines &&
			this.cachedProgress === this.progress &&
			this.cachedWidth === width &&
			this.cachedMessage === this.message
		) {
			return this.cachedLines;
		}

		const contentWidth = Math.max(1, width - this.paddingX * 2);
		const leftPad = " ".repeat(this.paddingX);

		// Calculate percentage label
		const percentLabel = this.showPercentage ? `${Math.round(this.progress * 100)}%` : "";
		const percentLabelWidth = this.showPercentage ? visibleWidth(percentLabel) + 1 : 0; // +1 for space

		// Calculate bar width
		let barWidth: number;
		if (this.barWidth !== undefined) {
			barWidth = Math.max(1, Math.min(this.barWidth, contentWidth - percentLabelWidth));
		} else {
			barWidth = Math.max(1, contentWidth - percentLabelWidth);
		}

		// Calculate filled/empty portions
		const filledWidth = Math.round(barWidth * this.progress);
		const emptyWidth = barWidth - filledWidth;

		// Build the bar
		const filledPart = this.theme.filled(this.filledChar.repeat(filledWidth));
		const emptyPart = this.theme.empty(this.emptyChar.repeat(emptyWidth));
		const bar = filledPart + emptyPart;

		// Build the line
		let line: string;
		if (this.showPercentage) {
			const styledLabel = this.theme.label ? this.theme.label(percentLabel) : percentLabel;
			line = `${bar} ${styledLabel}`;
		} else {
			line = bar;
		}

		// Pad to width
		const lineWidth = visibleWidth(line);
		const padding = Math.max(0, contentWidth - lineWidth);
		const paddedLine = leftPad + line + " ".repeat(padding) + " ".repeat(this.paddingX);

		const lines: string[] = [paddedLine];

		// Add message line if present
		if (this.message) {
			const styledMessage = this.theme.message ? this.theme.message(this.message) : this.message;
			const msgWidth = visibleWidth(styledMessage);
			const msgPadding = Math.max(0, contentWidth - msgWidth);
			lines.push(leftPad + styledMessage + " ".repeat(msgPadding) + " ".repeat(this.paddingX));
		}

		// Update cache
		this.cachedProgress = this.progress;
		this.cachedWidth = width;
		this.cachedMessage = this.message;
		this.cachedLines = lines;

		return lines;
	}
}
