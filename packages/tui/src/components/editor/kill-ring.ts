/**
 * Kill ring (clipboard ring) for Emacs-style kill/yank operations.
 */

/**
 * Manages the kill ring for cut/yank operations.
 * The kill ring stores deleted text and allows cycling through previous kills.
 */
export class KillRing {
	private ring: string[] = [];
	private lastAction: "kill" | "yank" | "type-word" | null = null;

	/**
	 * Add text to the kill ring.
	 * If last action was "kill", accumulates with the previous entry.
	 *
	 * @param text - The text to add
	 * @param prepend - If accumulating, prepend (true) or append (false) to existing entry
	 */
	add(text: string, prepend: boolean): void {
		if (!text) return;

		if (this.lastAction === "kill" && this.ring.length > 0) {
			// Accumulate with the most recent entry (at end of array)
			const lastEntry = this.ring.pop();
			if (prepend) {
				this.ring.push(text + lastEntry);
			} else {
				this.ring.push(lastEntry + text);
			}
		} else {
			// Add new entry to end of ring
			this.ring.push(text);
		}
	}

	peek(): string | undefined {
		return this.ring[this.ring.length - 1];
	}

	/** Moves top entry to bottom (for yank-pop) */
	rotate(): void {
		if (this.ring.length > 1) {
			const top = this.ring.pop();
			if (top !== undefined) {
				this.ring.unshift(top);
			}
		}
	}

	setLastAction(action: "kill" | "yank" | "type-word" | null): void {
		this.lastAction = action;
	}

	getLastAction(): "kill" | "yank" | "type-word" | null {
		return this.lastAction;
	}

	wasYank(): boolean {
		return this.lastAction === "yank";
	}

	/**
	 */
	wasKill(): boolean {
		return this.lastAction === "kill";
	}

	/**
	 * Check if the ring is empty.
	 */
	isEmpty(): boolean {
		return this.ring.length === 0;
	}

	/**
	 * Clear the kill ring.
	 */
	clear(): void {
		this.ring = [];
		this.lastAction = null;
	}

	/**
	 * Get the number of entries in the ring.
	 */
	get length(): number {
		return this.ring.length;
	}
}
