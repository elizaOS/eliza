import type { AgentContext } from "./components";
import type { JsonValue } from "./primitives";
import type { ServiceTypeName } from "./service";

export type SearchCategoryFilterType =
	| "string"
	| "number"
	| "boolean"
	| "date"
	| "enum"
	| "string[]"
	| "number[]"
	| (string & {});

export interface SearchCategoryFilterOption {
	label: string;
	value: JsonValue;
}

export interface SearchCategoryFilter {
	name: string;
	label?: string;
	description?: string;
	type?: SearchCategoryFilterType;
	required?: boolean;
	default?: JsonValue;
	options?: SearchCategoryFilterOption[];
}

export interface SearchCategoryRegistration {
	/** Stable planner-facing category id, for example `web`, `linear_issues`, or `youtube`. */
	category: string;
	label: string;
	description?: string;
	contexts?: AgentContext[];
	filters?: SearchCategoryFilter[];
	resultSchemaSummary?: string;
	capabilities?: string[];
	/** Defaults to true. Disabled categories remain addressable for clearer planner/action errors. */
	enabled?: boolean;
	disabledReason?: string;
	source?: string;
	serviceType?: ServiceTypeName | (string & {});
}

export interface SearchCategoryEnumerationOptions {
	includeDisabled?: boolean;
	contexts?: AgentContext[];
}

export interface SearchCategoryLookupOptions {
	includeDisabled?: boolean;
}

export type SearchCategoryRegistryErrorCode =
	| "SEARCH_CATEGORY_NOT_FOUND"
	| "SEARCH_CATEGORY_DISABLED";

export class SearchCategoryRegistryError extends Error {
	readonly code: SearchCategoryRegistryErrorCode;
	readonly category: string;

	constructor(
		code: SearchCategoryRegistryErrorCode,
		category: string,
		message: string,
	) {
		super(message);
		this.name = "SearchCategoryRegistryError";
		this.code = code;
		this.category = category;
	}
}
