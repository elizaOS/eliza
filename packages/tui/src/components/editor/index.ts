/**
 * Editor component module exports.
 *
 * The Editor is a multi-line text editor with support for:
 * - Word wrapping
 * - Cursor movement
 * - History navigation
 * - Undo/redo
 * - Kill ring (Emacs-style cut/paste)
 * - Autocomplete
 */

// Re-export the main Editor class from the parent directory
export { Editor } from "../editor.js";

// Export types
export type { EditorOptions, EditorState, EditorTheme, LayoutLine, TextChunk, VisualLineMapping } from "./types.js";

// Export layout utilities
export { buildVisualLineMap, findCurrentVisualLine, layoutText, wordWrapLine } from "./layout.js";

// Export history management
export { DEFAULT_HISTORY_LIMIT, EditorHistory } from "./history.js";

// Export undo management
export { restoreSnapshot, UndoManager } from "./undo.js";

// Export kill ring
export { KillRing } from "./kill-ring.js";
