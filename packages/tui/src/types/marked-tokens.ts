/**
 * TypeScript interfaces for marked library tokens.
 * These provide type-safe access to list and table tokens
 * without using `any` types.
 */

import type { Token } from "marked";

/**
 * A token representing an item in a list.
 */
export interface ListItemToken {
	type: "list_item";
	raw: string;
	task: boolean;
	checked?: boolean;
	loose: boolean;
	text: string;
	tokens: Token[];
}

/**
 * A token representing a list (ordered or unordered).
 */
export interface ListToken {
	type: "list";
	raw: string;
	ordered: boolean;
	start: number | "";
	loose: boolean;
	items: ListItemToken[];
}

/**
 * A token representing a cell in a table header or row.
 */
export interface TableCellToken {
	text: string;
	tokens: Token[];
	header: boolean;
	align: "center" | "left" | "right" | null;
}

/**
 * A token representing a table.
 */
export interface TableToken {
	type: "table";
	raw: string;
	align: Array<"center" | "left" | "right" | null>;
	header: TableCellToken[];
	rows: TableCellToken[][];
}

/**
 * Type guard to check if a token is a ListToken.
 */
export function isListToken(token: Token): token is ListToken {
	return token.type === "list";
}

/**
 * Type guard to check if a token is a TableToken.
 */
export function isTableToken(token: Token): token is TableToken {
	return token.type === "table";
}
