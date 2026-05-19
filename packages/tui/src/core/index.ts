/**
 * Core TUI module exports.
 */

// Re-export TUI class from parent (for backward compatibility)
export { TUI } from "../tui.js";
// Container
export { Container } from "./container.js";
// Overlay utilities
export {
  isOverlayVisible,
  parseSizeValue,
  type ResolvedOverlayLayout,
  resolveAnchorCol,
  resolveAnchorRow,
  resolveOverlayLayout,
} from "./overlay.js";
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
