/**
 * Command history management for the Editor component.
 */

/** Default maximum history size */
export const DEFAULT_HISTORY_LIMIT = 100;

/**
 * Manages command history for up/down arrow navigation.
 */
export class EditorHistory {
	private history: string[] = [];
	private historyIndex = -1; // -1 = not browsing, 0 = most recent, 1 = older, etc.
	private limit: number;

	constructor(limit: number = DEFAULT_HISTORY_LIMIT) {
		this.limit = limit;
	}

	/**
	 * Add a prompt to history for up/down arrow navigation.
	 * Called after successful submission.
	 *
	 * @param text - Text to add to history
	 */
	add(text: string): void {
		const trimmed = text.trim();
		if (!trimmed) return;
		// Don't add consecutive duplicates
		if (this.history.length > 0 && this.history[0] === trimmed) return;
		this.history.unshift(trimmed);
		// Limit history size
		if (this.history.length > this.limit) {
			this.history.pop();
		}
	}

	/**
	 * Navigate history in the specified direction.
	 *
	 * @param direction - 1 for newer, -1 for older
	 * @returns The history entry text, or null if navigation should be cancelled
	 */
	navigate(direction: 1 | -1): string | null {
		if (this.history.length === 0) return null;

		const newIndex = this.historyIndex - direction; // Up(-1) increases index, Down(1) decreases
		if (newIndex < -1 || newIndex >= this.history.length) return null;

		this.historyIndex = newIndex;

		if (this.historyIndex === -1) {
			return "";
		}

		// historyIndex is guaranteed in bounds (checked above)
		return this.history[this.historyIndex] as string;
	}

	/**
	 * Check if currently browsing history.
	 */
	isBrowsing(): boolean {
		return this.historyIndex !== -1;
	}

	getIndex(): number {
		return this.historyIndex;
	}

	willStartBrowsing(direction: 1 | -1): boolean {
		return this.historyIndex === -1 && direction === -1 && this.history.length > 0;
	}

	reset(): void {
		this.historyIndex = -1;
	}

	clear(): void {
		this.history = [];
		this.historyIndex = -1;
	}

	get length(): number {
		return this.history.length;
	}
}
