/**
 * Container component that holds and renders child components.
 */

import type { Component } from "./types.js";

/**
 * Container - a component that contains other components.
 * Children are rendered vertically (each component's lines are appended).
 */
export class Container implements Component {
	children: Component[] = [];

	/**
	 * Add a child component to the container.
	 */
	addChild(component: Component): void {
		this.children.push(component);
	}

	/**
	 * Remove a child component from the container.
	 */
	removeChild(component: Component): void {
		const index = this.children.indexOf(component);
		if (index !== -1) {
			this.children.splice(index, 1);
		}
	}

	/**
	 * Remove all children from the container.
	 */
	clear(): void {
		this.children = [];
	}

	/**
	 * Invalidate all children's cached state.
	 */
	invalidate(): void {
		for (const child of this.children) {
			child.invalidate?.();
		}
	}

	/**
	 * Render all children and concatenate their output.
	 */
	render(width: number): string[] {
		const lines: string[] = [];
		for (const child of this.children) {
			lines.push(...child.render(width));
		}
		return lines;
	}
}
