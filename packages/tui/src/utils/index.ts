/**
 * Shared utility modules for the TUI library.
 */

// Paste handling
export {
	cleanPasteForMultiLine,
	cleanPasteForSingleLine,
	PASTE_END,
	PasteHandler,
	type PasteHandlerResult,
	PASTE_START,
} from "./paste-handler.js";

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
