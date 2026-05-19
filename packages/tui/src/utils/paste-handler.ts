/**
 * Shared paste handling utilities for bracketed paste mode.
 *
 * Bracketed paste mode wraps pasted content with escape sequences:
 * - Start: \x1b[200~
 * - End: \x1b[201~
 *
 * This allows distinguishing between typed input and pasted content.
 */

/** Start marker for bracketed paste mode */
export const PASTE_START = "\x1b[200~";

/** End marker for bracketed paste mode */
export const PASTE_END = "\x1b[201~";

/**
 * Result of processing input through the paste handler.
 */
export interface PasteHandlerResult {
	/** Whether input was consumed by paste buffering */
	consumed: boolean;
	/** Remaining input to process after paste handling */
	remaining: string;
	/** Complete paste content if a paste was just finished */
	pasteContent: string | null;
}

/**
 * Handles bracketed paste mode for terminal input.
 *
 * Buffers input between paste start and end markers, then returns
 * the complete paste content once the end marker is received.
 *
 * @example
 * ```typescript
 * const pasteHandler = new PasteHandler();
 *
 * function handleInput(data: string): void {
 *   const result = pasteHandler.handleInput(data);
 *
 *   if (result.pasteContent !== null) {
 *     // Process the pasted content
 *     insertText(result.pasteContent);
 *   }
 *
 *   if (!result.consumed && result.remaining) {
 *     // Process remaining input normally
 *     processKeystrokes(result.remaining);
 *   }
 * }
 * ```
 */
export class PasteHandler {
	private buffer = "";
	private isInPaste = false;

	/**
	 * Process input data for bracketed paste mode.
	 *
	 * @param data - Raw input data
	 * @returns Result indicating whether input was consumed and any paste content
	 */
	handleInput(data: string): PasteHandlerResult {
		// Check if we're starting a bracketed paste
		if (data.includes(PASTE_START)) {
			this.isInPaste = true;
			this.buffer = "";
			data = data.replace(PASTE_START, "");
		}

		// If we're in a paste, buffer the data
		if (this.isInPaste) {
			this.buffer += data;

			const endIndex = this.buffer.indexOf(PASTE_END);
			if (endIndex !== -1) {
				// Extract the pasted content
				const pasteContent = this.buffer.substring(0, endIndex);

				// Reset paste state
				this.isInPaste = false;

				// Get any remaining input after the paste marker
				const remaining = this.buffer.substring(endIndex + PASTE_END.length);
				this.buffer = "";

				return {
					consumed: true,
					remaining,
					pasteContent,
				};
			}

			// Still buffering, waiting for end marker
			return {
				consumed: true,
				remaining: "",
				pasteContent: null,
			};
		}

		// Not in a paste - return input unchanged
		return {
			consumed: false,
			remaining: data,
			pasteContent: null,
		};
	}

	/**
	 * Reset the paste handler state.
	 * Useful if paste sequence is interrupted or needs to be cancelled.
	 */
	reset(): void {
		this.buffer = "";
		this.isInPaste = false;
	}

	/**
	 * Check if currently buffering a paste.
	 */
	isBuffering(): boolean {
		return this.isInPaste;
	}
}

/**
 * Clean pasted text for single-line input fields.
 * Removes newlines and carriage returns.
 *
 * @param text - Raw pasted text
 * @returns Cleaned text suitable for single-line input
 */
export function cleanPasteForSingleLine(text: string): string {
	return text.replace(/\r\n/g, "").replace(/\r/g, "").replace(/\n/g, "");
}

/**
 * Clean pasted text for multi-line editors.
 * Normalizes line endings to LF.
 *
 * @param text - Raw pasted text
 * @returns Cleaned text with normalized line endings
 */
export function cleanPasteForMultiLine(text: string): string {
	return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}
