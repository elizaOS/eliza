/**
 * Shared utility modules for the TUI library.
 */

// Cursor movement and text editing
export {
  type CursorPosition,
  deleteGraphemeBackward,
  deleteGraphemeForward,
  deleteToLineEnd,
  deleteToLineStart,
  deleteWordBackward,
  hasControlChars,
  insertTextAtCursor,
  isControlChar,
  moveCursorLeft,
  moveCursorRight,
  moveWordBackwards,
  moveWordForwards,
  type TextEditResult,
} from "./cursor-movement.js";
// Paste handling
export {
  cleanPasteForMultiLine,
  cleanPasteForSingleLine,
  PASTE_END,
  PASTE_START,
  PasteHandler,
  type PasteHandlerResult,
} from "./paste-handler.js";
