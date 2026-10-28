/** Browser-safe JSON Schema shapes for action parameters and generated objects. */
import type { JsonValue } from "./json";

/**
 * JSON Schema type for action parameter validation.
 * Supports basic JSON Schema properties for parameter definition.
 */
export interface ActionParameterSchema {
	/**
	 * JSON Schema instance type. Optional because a schema may instead be a
	 * pure union (`oneOf`/`anyOf`) — a sibling `type` alongside union branches
	 * of differing types contradicts the branches, and strict provider
	 * grammars reject the contradiction. A schema should carry `type` or a
	 * union keyword, never neither.
	 */
	type?: string;
	description?: string;
	/** Default value if parameter is not provided */
	default?: JsonValue | null;
	/** For object types, define nested properties */
	properties?: Record<string, ActionParameterSchema>;
	/** Required child property names for object-valued parameters */
	required?: string[];
	/** Whether object-valued parameters allow undeclared properties */
	additionalProperties?: boolean | ActionParameterSchema;
	/** For array types, define the item schema */
	items?: ActionParameterSchema;
	/** Enumerated allowed values (schema-compatible) */
	enumValues?: Array<string | number | boolean | null>;
	/** Enumerated allowed values */
	enum?: Array<string | number | boolean | null>;
	/** Minimum string length for string-valued parameters */
	minLength?: number;
	/** Maximum string length for string-valued parameters */
	maxLength?: number;
	/** Regular expression pattern for string-valued parameters */
	pattern?: string;
	/** Numeric minimum */
	minimum?: number;
	/** Numeric maximum */
	maximum?: number;
	/** JSON Schema `oneOf`: value must match exactly one sub-schema */
	oneOf?: ReadonlyArray<ActionParameterSchema>;
	/** JSON Schema `anyOf`: value must match at least one sub-schema */
	anyOf?: ReadonlyArray<ActionParameterSchema>;
}

/**
 * Optional JSON schema for validating generated objects
 */
export interface JSONSchema {
	type?: string | string[];
	properties?: Record<string, JSONSchema>;
	items?: JSONSchema | JSONSchema[];
	required?: string[];
	[key: string]: JsonValue | JSONSchema | JSONSchema[] | undefined;
}
