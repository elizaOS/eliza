/**
 * Undo/redo support for the Editor component.
 */

import type { EditorState } from "./types.js";

/**
 * Manages undo stack for the Editor.
 */
export class UndoManager {
	private stack: EditorState[] = [];

	/**
	 * Capture a snapshot of the current state.
	 *
	 * @param state - Current editor state
	 * @returns Deep clone of the state
	 */
	captureSnapshot(state: EditorState): EditorState {
		return structuredClone(state);
	}

	/**
	 * Push a snapshot onto the undo stack.
	 *
	 * @param state - Current editor state to save
	 */
	push(state: EditorState): void {
		this.stack.push(this.captureSnapshot(state));
	}

	/**
	 * Pop and return the most recent snapshot.
	 *
	 * @returns The previous state, or undefined if stack is empty
	 */
	pop(): EditorState | undefined {
		return this.stack.pop();
	}

	/**
	 * Check if there are any undo snapshots available.
	 */
	canUndo(): boolean {
		return this.stack.length > 0;
	}

	/**
	 * Clear the undo stack.
	 */
	clear(): void {
		this.stack.length = 0;
	}

	get length(): number {
		return this.stack.length;
	}
}

/**
 * Restore an undo snapshot to the target state object.
 *
 * @param target - State object to restore to
 * @param snapshot - Snapshot to restore
 */
export function restoreSnapshot(target: EditorState, snapshot: EditorState): void {
	Object.assign(target, structuredClone(snapshot));
}
