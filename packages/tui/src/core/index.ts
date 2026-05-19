/**
 * Core TUI module exports.
 */

// Types and interfaces
export type {
	Component,
	Focusable,
	OverlayAnchor,
	OverlayEntry,
	OverlayHandle,
	OverlayMargin,
	OverlayOptions,
	SizeValue,
} from "./types.js";

export { CURSOR_MARKER, isFocusable } from "./types.js";

// Container
export { Container } from "./container.js";

// Overlay utilities
export {
	isOverlayVisible,
	parseSizeValue,
	resolveAnchorCol,
	resolveAnchorRow,
	resolveOverlayLayout,
	type ResolvedOverlayLayout,
} from "./overlay.js";

// Re-export TUI class from parent (for backward compatibility)
export { TUI } from "../tui.js";
