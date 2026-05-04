/**
 * @module builtins
 * @description Built-in control types for the Form Plugin
 *
 * Standard control types available out of the box:
 * text, number, email, boolean, select, date, file
 */

import type { JsonValue } from "../../../types/index.ts";
import type { ControlType, FormControl, ValidationResult } from "./types.ts";

// ============================================================================
// VALIDATION HELPERS
// ============================================================================

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ISO_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

// ============================================================================
// BUILT-IN CONTROL TYPES
// ============================================================================

const textType: ControlType = {
	id: "text",
	builtin: true,

	validate: (value: JsonValue, control: FormControl): ValidationResult => {
		if (value === null || value === undefined) {
			return { valid: true };
		}

		const str = String(value);

		if (control.minLength !== undefined && str.length < control.minLength) {
			return {
				valid: false,
				error: `Must be at least ${control.minLength} characters`,
			};
		}

		if (control.maxLength !== undefined && str.length > control.maxLength) {
			return {
				valid: false,
				error: `Must be at most ${control.maxLength} characters`,
			};
		}

		if (control.pattern) {
			const regex = new RegExp(control.pattern);
			if (!regex.test(str)) {
				return { valid: false, error: "Invalid format" };
			}
		}

		if (control.enum && !control.enum.includes(str)) {
			return {
				valid: false,
				error: `Must be one of: ${control.enum.join(", ")}`,
			};
		}

		return { valid: true };
	},

	parse: (value: string): string => String(value).trim(),

	format: (value: JsonValue): string => String(value ?? ""),

	extractionPrompt: "a text string",
};

const numberType: ControlType = {
	id: "number",
	builtin: true,

	validate: (value: JsonValue, control: FormControl): ValidationResult => {
		if (value === null || value === undefined || value === "") {
			return { valid: true };
		}

		const num = typeof value === "number" ? value : parseFloat(String(value));

		if (Number.isNaN(num)) {
			return { valid: false, error: "Must be a valid number" };
		}

		if (control.min !== undefined && num < control.min) {
			return { valid: false, error: `Must be at least ${control.min}` };
		}

		if (control.max !== undefined && num > control.max) {
			return { valid: false, error: `Must be at most ${control.max}` };
		}

		return { valid: true };
	},

	parse: (value: string): number => {
		const cleaned = value.replace(/[,$\s]/g, "");
		return parseFloat(cleaned);
	},

	format: (value: JsonValue): string => {
		if (value === null || value === undefined) return "";
		const num = typeof value === "number" ? value : parseFloat(String(value));
		if (Number.isNaN(num)) return String(value);
		return num.toLocaleString();
	},

	extractionPrompt: "a number (integer or decimal)",
};

const emailType: ControlType = {
	id: "email",
	builtin: true,

	validate: (value: JsonValue): ValidationResult => {
		if (value === null || value === undefined || value === "") {
			return { valid: true };
		}

		const str = String(value).trim().toLowerCase();

		if (!EMAIL_REGEX.test(str)) {
			return { valid: false, error: "Invalid email format" };
		}

		return { valid: true };
	},

	parse: (value: string): string => value.trim().toLowerCase(),

	format: (value: JsonValue): string => String(value ?? "").toLowerCase(),

	extractionPrompt: "an email address (e.g., user@example.com)",
};

const booleanType: ControlType = {
	id: "boolean",
	builtin: true,

	validate: (value: JsonValue): ValidationResult => {
		if (value === null || value === undefined) {
			return { valid: true };
		}

		if (typeof value === "boolean") {
			return { valid: true };
		}

		const str = String(value).toLowerCase();
		const validValues = ["true", "false", "yes", "no", "1", "0", "on", "off"];

		if (!validValues.includes(str)) {
			return { valid: false, error: "Must be yes/no or true/false" };
		}

		return { valid: true };
	},

	parse: (value: string): boolean => {
		const str = value.toLowerCase();
		return ["true", "yes", "1", "on"].includes(str);
	},

	format: (value: JsonValue): string => {
		if (value === true) return "Yes";
		if (value === false) return "No";
		return String(value ?? "");
	},

	extractionPrompt: "a yes/no or true/false value",
};

const selectType: ControlType = {
	id: "select",
	builtin: true,

	validate: (value: JsonValue, control: FormControl): ValidationResult => {
		if (value === null || value === undefined || value === "") {
			return { valid: true };
		}

		const str = String(value);

		if (control.options) {
			const validValues = control.options.map((o) => o.value);
			if (!validValues.includes(str)) {
				const labels = control.options.map((o) => o.label).join(", ");
				return { valid: false, error: `Must be one of: ${labels}` };
			}
		}

		if (control.enum && !control.options) {
			if (!control.enum.includes(str)) {
				return {
					valid: false,
					error: `Must be one of: ${control.enum.join(", ")}`,
				};
			}
		}

		return { valid: true };
	},

	parse: (value: string): string => value.trim(),

	format: (value: JsonValue): string => String(value ?? ""),

	extractionPrompt: "one of the available options",
};

const dateType: ControlType = {
	id: "date",
	builtin: true,

	validate: (value: JsonValue): ValidationResult => {
		if (value === null || value === undefined || value === "") {
			return { valid: true };
		}

		const str = String(value);

		if (!ISO_DATE_REGEX.test(str)) {
			return { valid: false, error: "Must be in YYYY-MM-DD format" };
		}

		const date = new Date(str);
		if (Number.isNaN(date.getTime())) {
			return { valid: false, error: "Invalid date" };
		}

		return { valid: true };
	},

	parse: (value: string): string => {
		const date = new Date(value);
		if (!Number.isNaN(date.getTime())) {
			return date.toISOString().split("T")[0];
		}
		return value.trim();
	},

	format: (value: JsonValue): string => {
		if (!value) return "";
		const date = new Date(String(value));
		if (Number.isNaN(date.getTime())) return String(value);
		return date.toLocaleDateString();
	},

	extractionPrompt: "a date (preferably in YYYY-MM-DD format)",
};

const fileType: ControlType = {
	id: "file",
	builtin: true,

	validate: (value: JsonValue, _control: FormControl): ValidationResult => {
		if (value === null || value === undefined) {
			return { valid: true };
		}

		if (typeof value === "object") {
			return { valid: true };
		}

		return { valid: false, error: "Invalid file data" };
	},

	format: (value: JsonValue): string => {
		if (!value) return "";
		if (Array.isArray(value)) {
			return `${value.length} file(s)`;
		}
		if (typeof value === "object" && value !== null && "name" in value) {
			return String((value as { name: string }).name);
		}
		return "File attached";
	},

	extractionPrompt: "a file attachment (upload required)",
};

// ============================================================================
// EXPORTS
// ============================================================================

export const BUILTIN_TYPES: ControlType[] = [
	textType,
	numberType,
	emailType,
	booleanType,
	selectType,
	dateType,
	fileType,
];

export const BUILTIN_TYPE_MAP: Map<string, ControlType> = new Map(
	BUILTIN_TYPES.map((t) => [t.id, t]),
);

export function registerBuiltinTypes(
	registerFn: (
		type: ControlType,
		options?: { allowOverride?: boolean },
	) => void,
): void {
	for (const type of BUILTIN_TYPES) {
		registerFn(type);
	}
}

export function getBuiltinType(id: string): ControlType | undefined {
	return BUILTIN_TYPE_MAP.get(id);
}

export function isBuiltinType(id: string): boolean {
	return BUILTIN_TYPE_MAP.has(id);
}
