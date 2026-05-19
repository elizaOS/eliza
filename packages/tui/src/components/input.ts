import { getEditorKeybindings } from "../keybindings.js";
import { type Component, CURSOR_MARKER, type Focusable } from "../tui.js";
import { getSegmenter, visibleWidth } from "../utils.js";
import {
	cleanPasteForSingleLine,
	deleteGraphemeBackward,
	deleteGraphemeForward,
	deleteWordBackward,
	hasControlChars,
	moveCursorLeft,
	moveCursorRight,
	moveWordBackwards,
	moveWordForwards,
	PasteHandler,
} from "../utils/index.js";

const segmenter = getSegmenter();

/**
 * Input component - single-line text input with horizontal scrolling
 */
export class Input implements Component, Focusable {
	private value: string = "";
	private cursor: number = 0; // Cursor position in the value
	public onSubmit?: (value: string) => void;
	public onEscape?: () => void;

	/** Focusable interface - set by TUI when focus changes */
	focused: boolean = false;

	// Bracketed paste mode handler
	private pasteHandler = new PasteHandler();

	getValue(): string {
		return this.value;
	}

	setValue(value: string): void {
		this.value = value;
		this.cursor = Math.min(this.cursor, value.length);
	}

	handleInput(data: string): void {
		// Handle bracketed paste mode
		const pasteResult = this.pasteHandler.handleInput(data);

		if (pasteResult.pasteContent !== null) {
			// Process the complete paste
			const cleanText = cleanPasteForSingleLine(pasteResult.pasteContent);
			this.value = this.value.slice(0, this.cursor) + cleanText + this.value.slice(this.cursor);
			this.cursor += cleanText.length;
		}

		if (pasteResult.consumed) {
			// Handle any remaining input after the paste
			if (pasteResult.remaining) {
				this.handleInput(pasteResult.remaining);
			}
			return;
		}

		const kb = getEditorKeybindings();

		// Escape/Cancel
		if (kb.matches(data, "selectCancel")) {
			if (this.onEscape) this.onEscape();
			return;
		}

		// Submit
		if (kb.matches(data, "submit") || data === "\n") {
			if (this.onSubmit) this.onSubmit(this.value);
			return;
		}

		// Deletion
		if (kb.matches(data, "deleteCharBackward")) {
			const result = deleteGraphemeBackward(this.value, this.cursor);
			this.value = result.text;
			this.cursor = result.cursor;
			return;
		}

		if (kb.matches(data, "deleteCharForward")) {
			const result = deleteGraphemeForward(this.value, this.cursor);
			this.value = result.text;
			this.cursor = result.cursor;
			return;
		}

		if (kb.matches(data, "deleteWordBackward")) {
			const result = deleteWordBackward(this.value, this.cursor);
			this.value = result.text;
			this.cursor = result.cursor;
			return;
		}

		if (kb.matches(data, "deleteToLineStart")) {
			this.value = this.value.slice(this.cursor);
			this.cursor = 0;
			return;
		}

		if (kb.matches(data, "deleteToLineEnd")) {
			this.value = this.value.slice(0, this.cursor);
			return;
		}

		// Cursor movement
		if (kb.matches(data, "cursorLeft")) {
			this.cursor = moveCursorLeft(this.value, this.cursor);
			return;
		}

		if (kb.matches(data, "cursorRight")) {
			this.cursor = moveCursorRight(this.value, this.cursor);
			return;
		}

		if (kb.matches(data, "cursorLineStart")) {
			this.cursor = 0;
			return;
		}

		if (kb.matches(data, "cursorLineEnd")) {
			this.cursor = this.value.length;
			return;
		}

		if (kb.matches(data, "cursorWordLeft")) {
			this.cursor = moveWordBackwards(this.value, this.cursor);
			return;
		}

		if (kb.matches(data, "cursorWordRight")) {
			this.cursor = moveWordForwards(this.value, this.cursor);
			return;
		}

		// Regular character input - accept printable characters including Unicode,
		// but reject control characters (C0: 0x00-0x1F, DEL: 0x7F, C1: 0x80-0x9F)
		if (!hasControlChars(data)) {
			this.value = this.value.slice(0, this.cursor) + data + this.value.slice(this.cursor);
			this.cursor += data.length;
		}
	}

	invalidate(): void {
		// No cached state to invalidate currently
	}

	render(width: number): string[] {
		// Calculate visible window
		const prompt = "> ";
		const availableWidth = width - prompt.length;

		if (availableWidth <= 0) {
			return [prompt];
		}

		let visibleText = "";
		let cursorDisplay = this.cursor;

		if (this.value.length < availableWidth) {
			// Everything fits (leave room for cursor at end)
			visibleText = this.value;
		} else {
			// Need horizontal scrolling
			// Reserve one character for cursor if it's at the end
			const scrollWidth = this.cursor === this.value.length ? availableWidth - 1 : availableWidth;
			const halfWidth = Math.floor(scrollWidth / 2);

			const findValidStart = (start: number) => {
				while (start < this.value.length) {
					const charCode = this.value.charCodeAt(start);
					// this is low surrogate, not a valid start
					if (charCode >= 0xdc00 && charCode < 0xe000) {
						start++;
						continue;
					}
					break;
				}
				return start;
			};

			const findValidEnd = (end: number) => {
				while (end > 0) {
					const charCode = this.value.charCodeAt(end - 1);
					// this is high surrogate, might be split.
					if (charCode >= 0xd800 && charCode < 0xdc00) {
						end--;
						continue;
					}
					break;
				}
				return end;
			};

			if (this.cursor < halfWidth) {
				// Cursor near start
				visibleText = this.value.slice(0, findValidEnd(scrollWidth));
				cursorDisplay = this.cursor;
			} else if (this.cursor > this.value.length - halfWidth) {
				// Cursor near end
				const start = findValidStart(this.value.length - scrollWidth);
				visibleText = this.value.slice(start);
				cursorDisplay = this.cursor - start;
			} else {
				// Cursor in middle
				const start = findValidStart(this.cursor - halfWidth);
				visibleText = this.value.slice(start, findValidEnd(start + scrollWidth));
				cursorDisplay = halfWidth;
			}
		}

		// Build line with fake cursor
		// Insert cursor character at cursor position
		const graphemes = [...segmenter.segment(visibleText.slice(cursorDisplay))];
		const cursorGrapheme = graphemes[0];

		const beforeCursor = visibleText.slice(0, cursorDisplay);
		const atCursor = cursorGrapheme?.segment ?? " "; // Character at cursor, or space if at end
		const afterCursor = visibleText.slice(cursorDisplay + atCursor.length);

		// Hardware cursor marker (zero-width, emitted before fake cursor for IME positioning)
		const marker = this.focused ? CURSOR_MARKER : "";

		// Use inverse video to show cursor
		const cursorChar = `\x1b[7m${atCursor}\x1b[27m`; // ESC[7m = reverse video, ESC[27m = normal
		const textWithCursor = beforeCursor + marker + cursorChar + afterCursor;

		// Calculate visual width
		const visualLength = visibleWidth(textWithCursor);
		const padding = " ".repeat(Math.max(0, availableWidth - visualLength));
		const line = prompt + textWithCursor + padding;

		return [line];
	}
}
