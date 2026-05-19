/**
 * Overlay positioning and layout utilities.
 */

import { DEFAULT_TERMINAL_WIDTH } from "../constants.js";
import type { OverlayAnchor, OverlayEntry, OverlayOptions, SizeValue } from "./types.js";

/**
 * Resolved overlay layout with computed positions.
 */
export interface ResolvedOverlayLayout {
	width: number;
	row: number;
	col: number;
	maxHeight: number | undefined;
}

/**
 * Parse a SizeValue into absolute value given a reference size.
 *
 * @param value - Size value (number or percentage string)
 * @param referenceSize - Reference size for percentage calculation
 * @returns Absolute value, or undefined if value is undefined
 */
export function parseSizeValue(value: SizeValue | undefined, referenceSize: number): number | undefined {
	if (value === undefined) return undefined;
	if (typeof value === "number") return value;
	// Parse percentage string like "50%"
	const match = value.match(/^(\d+(?:\.\d+)?)%$/);
	if (match) {
		return Math.floor((referenceSize * parseFloat(match[1])) / 100);
	}
	return undefined;
}

/**
 * Resolve row position based on anchor.
 */
export function resolveAnchorRow(
	anchor: OverlayAnchor,
	height: number,
	availHeight: number,
	marginTop: number,
): number {
	switch (anchor) {
		case "top-left":
		case "top-center":
		case "top-right":
			return marginTop;
		case "bottom-left":
		case "bottom-center":
		case "bottom-right":
			return marginTop + availHeight - height;
		case "left-center":
		case "center":
		case "right-center":
			return marginTop + Math.floor((availHeight - height) / 2);
	}
}

/**
 * Resolve column position based on anchor.
 */
export function resolveAnchorCol(
	anchor: OverlayAnchor,
	width: number,
	availWidth: number,
	marginLeft: number,
): number {
	switch (anchor) {
		case "top-left":
		case "left-center":
		case "bottom-left":
			return marginLeft;
		case "top-right":
		case "right-center":
		case "bottom-right":
			return marginLeft + availWidth - width;
		case "top-center":
		case "center":
		case "bottom-center":
			return marginLeft + Math.floor((availWidth - width) / 2);
	}
}

/**
 * Resolve overlay layout from options.
 *
 * @param options - Overlay positioning options
 * @param overlayHeight - Height of the overlay content
 * @param termWidth - Terminal width
 * @param termHeight - Terminal height
 * @returns Resolved layout with width, row, col, maxHeight
 */
export function resolveOverlayLayout(
	options: OverlayOptions | undefined,
	overlayHeight: number,
	termWidth: number,
	termHeight: number,
): ResolvedOverlayLayout {
	const opt = options ?? {};

	// Parse margin (clamp to non-negative)
	const margin =
		typeof opt.margin === "number"
			? { top: opt.margin, right: opt.margin, bottom: opt.margin, left: opt.margin }
			: (opt.margin ?? {});
	const marginTop = Math.max(0, margin.top ?? 0);
	const marginRight = Math.max(0, margin.right ?? 0);
	const marginBottom = Math.max(0, margin.bottom ?? 0);
	const marginLeft = Math.max(0, margin.left ?? 0);

	// Available space after margins
	const availWidth = Math.max(1, termWidth - marginLeft - marginRight);
	const availHeight = Math.max(1, termHeight - marginTop - marginBottom);

	// === Resolve width ===
	let width = parseSizeValue(opt.width, termWidth) ?? Math.min(DEFAULT_TERMINAL_WIDTH, availWidth);
	// Apply minWidth
	if (opt.minWidth !== undefined) {
		width = Math.max(width, opt.minWidth);
	}
	// Clamp to available space
	width = Math.max(1, Math.min(width, availWidth));

	// === Resolve maxHeight ===
	let maxHeight = parseSizeValue(opt.maxHeight, termHeight);
	// Clamp to available space
	if (maxHeight !== undefined) {
		maxHeight = Math.max(1, Math.min(maxHeight, availHeight));
	}

	// Effective overlay height (may be clamped by maxHeight)
	const effectiveHeight = maxHeight !== undefined ? Math.min(overlayHeight, maxHeight) : overlayHeight;

	// === Resolve position ===
	let row: number;
	let col: number;

	if (opt.row !== undefined) {
		if (typeof opt.row === "string") {
			// Percentage: 0% = top, 100% = bottom (overlay stays within bounds)
			const match = opt.row.match(/^(\d+(?:\.\d+)?)%$/);
			if (match) {
				const maxRow = Math.max(0, availHeight - effectiveHeight);
				const percent = parseFloat(match[1]) / 100;
				row = marginTop + Math.floor(maxRow * percent);
			} else {
				// Invalid format, fall back to center
				row = resolveAnchorRow("center", effectiveHeight, availHeight, marginTop);
			}
		} else {
			// Absolute row position
			row = opt.row;
		}
	} else {
		// Anchor-based (default: center)
		const anchor = opt.anchor ?? "center";
		row = resolveAnchorRow(anchor, effectiveHeight, availHeight, marginTop);
	}

	if (opt.col !== undefined) {
		if (typeof opt.col === "string") {
			// Percentage: 0% = left, 100% = right (overlay stays within bounds)
			const match = opt.col.match(/^(\d+(?:\.\d+)?)%$/);
			if (match) {
				const maxCol = Math.max(0, availWidth - width);
				const percent = parseFloat(match[1]) / 100;
				col = marginLeft + Math.floor(maxCol * percent);
			} else {
				// Invalid format, fall back to center
				col = resolveAnchorCol("center", width, availWidth, marginLeft);
			}
		} else {
			// Absolute column position
			col = opt.col;
		}
	} else {
		// Anchor-based (default: center)
		const anchor = opt.anchor ?? "center";
		col = resolveAnchorCol(anchor, width, availWidth, marginLeft);
	}

	// Apply offsets
	if (opt.offsetY !== undefined) row += opt.offsetY;
	if (opt.offsetX !== undefined) col += opt.offsetX;

	// Clamp to terminal bounds (respecting margins)
	row = Math.max(marginTop, Math.min(row, termHeight - marginBottom - effectiveHeight));
	col = Math.max(marginLeft, Math.min(col, termWidth - marginRight - width));

	return { width, row, col, maxHeight };
}

/**
 * Check if an overlay is visible based on its hidden state and visibility function.
 */
export function isOverlayVisible(
	entry: OverlayEntry,
	termWidth?: number,
	termHeight?: number,
): boolean {
	if (entry.hidden) return false;
	if (entry.options?.visible && termWidth !== undefined && termHeight !== undefined) {
		return entry.options.visible(termWidth, termHeight);
	}
	return true;
}
