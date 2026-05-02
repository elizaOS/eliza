/**
 * @module validation
 * @description Field validation utilities for the Form Plugin
 */

import type { JsonValue } from "../../../types/index.ts";
import type { FormControl, TypeHandler } from "./types.ts";

/**
 * Validation result.
 */
export interface ValidationResult {
	valid: boolean;
	error?: string;
}

// ============================================================================
// TYPE HANDLER REGISTRY
// ============================================================================

const typeHandlers: Map<string, TypeHandler> = new Map();

export function registerTypeHandler(type: string, handler: TypeHandler): void {
	typeHandlers.set(type, handler);
}

export function getTypeHandler(type: string): TypeHandler | undefined {
	return typeHandlers.get(type);
}

export function clearTypeHandlers(): void {
	typeHandlers.clear();
}

// ============================================================================
// FIELD VALIDATION
// ============================================================================

/**
 * Validate a value against a control's validation rules.
 */
export function validateField(
	value: JsonValue,
	control: FormControl,
): ValidationResult {
	// Check required first
	if (control.required) {
		if (value === undefined || value === null || value === "") {
			return {
				valid: false,
				error: `${control.label || control.key} is required`,
			};
		}
	}

	// Empty optional fields are valid
	if (value === undefined || value === null || value === "") {
		return { valid: true };
	}

	// Check custom type handler first
	const handler = typeHandlers.get(control.type);
	if (handler?.validate) {
		const result = handler.validate(value, control);
		if (!result.valid) {
			return result;
		}
	}

	switch (control.type) {
		case "email":
			return validateEmail(value, control);
		case "number":
			return validateNumber(value, control);
		case "boolean":
			return validateBoolean(value, control);
		case "date":
			return validateDate(value, control);
		case "select":
			return validateSelect(value, control);
		case "file":
			return validateFile(value, control);
		default:
			return validateText(value, control);
	}
}

function validateText(
	value: JsonValue,
	control: FormControl,
): ValidationResult {
	const strValue = String(value);

	if (control.pattern) {
		const regex = new RegExp(control.pattern);
		if (!regex.test(strValue)) {
			return {
				valid: false,
				error: `${control.label || control.key} has invalid format`,
			};
		}
	}

	if (control.minLength !== undefined && strValue.length < control.minLength) {
		return {
			valid: false,
			error: `${control.label || control.key} must be at least ${control.minLength} characters`,
		};
	}

	if (control.maxLength !== undefined && strValue.length > control.maxLength) {
		return {
			valid: false,
			error: `${control.label || control.key} must be at most ${control.maxLength} characters`,
		};
	}

	if (control.enum && control.enum.length > 0) {
		if (!control.enum.includes(strValue)) {
			return {
				valid: false,
				error: `${control.label || control.key} must be one of: ${control.enum.join(", ")}`,
			};
		}
	}

	return { valid: true };
}

function validateEmail(
	value: JsonValue,
	control: FormControl,
): ValidationResult {
	const strValue = String(value);

	const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
	if (!emailRegex.test(strValue)) {
		return {
			valid: false,
			error: `${control.label || control.key} must be a valid email address`,
		};
	}

	return validateText(value, control);
}

function validateNumber(
	value: JsonValue,
	control: FormControl,
): ValidationResult {
	const numValue =
		typeof value === "number"
			? value
			: parseFloat(String(value).replace(/[,$]/g, ""));

	if (Number.isNaN(numValue)) {
		return {
			valid: false,
			error: `${control.label || control.key} must be a number`,
		};
	}

	if (control.min !== undefined && numValue < control.min) {
		return {
			valid: false,
			error: `${control.label || control.key} must be at least ${control.min}`,
		};
	}

	if (control.max !== undefined && numValue > control.max) {
		return {
			valid: false,
			error: `${control.label || control.key} must be at most ${control.max}`,
		};
	}

	return { valid: true };
}

function validateBoolean(
	value: JsonValue,
	_control: FormControl,
): ValidationResult {
	if (typeof value === "boolean") {
		return { valid: true };
	}

	const strValue = String(value).toLowerCase();
	const truthy = ["true", "yes", "1", "on"];
	const falsy = ["false", "no", "0", "off"];

	if (truthy.includes(strValue) || falsy.includes(strValue)) {
		return { valid: true };
	}

	return { valid: false, error: "Must be true or false" };
}

function validateDate(
	value: JsonValue,
	control: FormControl,
): ValidationResult {
	let dateValue: Date;

	if (value instanceof Date) {
		dateValue = value;
	} else if (typeof value === "string" || typeof value === "number") {
		dateValue = new Date(value);
	} else {
		return {
			valid: false,
			error: `${control.label || control.key} must be a valid date`,
		};
	}

	if (Number.isNaN(dateValue.getTime())) {
		return {
			valid: false,
			error: `${control.label || control.key} must be a valid date`,
		};
	}

	if (control.min !== undefined && dateValue.getTime() < control.min) {
		return {
			valid: false,
			error: `${control.label || control.key} is too early`,
		};
	}

	if (control.max !== undefined && dateValue.getTime() > control.max) {
		return {
			valid: false,
			error: `${control.label || control.key} is too late`,
		};
	}

	return { valid: true };
}

function validateSelect(
	value: JsonValue,
	control: FormControl,
): ValidationResult {
	if (!control.options || control.options.length === 0) {
		return { valid: true };
	}

	const strValue = String(value);
	const validValues = control.options.map((opt) => opt.value);

	if (!validValues.includes(strValue)) {
		return {
			valid: false,
			error: `${control.label || control.key} must be one of the available options`,
		};
	}

	return { valid: true };
}

function validateFile(
	value: JsonValue,
	control: FormControl,
): ValidationResult {
	if (!control.file) {
		return { valid: true };
	}

	const files = Array.isArray(value) ? value : [value];

	if (control.file.maxFiles && files.length > control.file.maxFiles) {
		return {
			valid: false,
			error: `Maximum ${control.file.maxFiles} files allowed`,
		};
	}

	for (const file of files) {
		if (!file || typeof file !== "object") continue;

		const fileObj = file as { size?: number; mimeType?: string };

		if (
			control.file.maxSize &&
			fileObj.size &&
			fileObj.size > control.file.maxSize
		) {
			return {
				valid: false,
				error: `File size exceeds maximum of ${formatBytes(control.file.maxSize)}`,
			};
		}

		if (control.file.accept && fileObj.mimeType) {
			const { mimeType } = fileObj;
			const accepted = control.file.accept.some((pattern) =>
				matchesMimeType(mimeType, pattern),
			);
			if (!accepted) {
				return {
					valid: false,
					error: `File type ${mimeType} is not accepted`,
				};
			}
		}
	}

	return { valid: true };
}

export function matchesMimeType(mimeType: string, pattern: string): boolean {
	if (pattern === "*/*") return true;
	if (pattern.endsWith("/*")) {
		const prefix = pattern.slice(0, -1);
		return mimeType.startsWith(prefix);
	}
	return mimeType === pattern;
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	if (bytes < 1024 * 1024 * 1024)
		return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

// ============================================================================
// VALUE PARSING
// ============================================================================

export function parseValue(value: string, control: FormControl): JsonValue {
	const handler = typeHandlers.get(control.type);
	if (handler?.parse) {
		return handler.parse(value);
	}

	switch (control.type) {
		case "number":
			return parseFloat(value.replace(/[,$]/g, ""));

		case "boolean": {
			const lower = value.toLowerCase();
			return ["true", "yes", "1", "on"].includes(lower);
		}

		case "date": {
			const timestamp = Date.parse(value);
			return Number.isFinite(timestamp)
				? new Date(timestamp).toISOString()
				: value;
		}
		default:
			return value;
	}
}

// ============================================================================
// VALUE FORMATTING
// ============================================================================

export function formatValue(value: JsonValue, control: FormControl): string {
	if (value === undefined || value === null) return "";

	const handler = typeHandlers.get(control.type);
	if (handler?.format) {
		return handler.format(value);
	}

	if (control.sensitive) {
		const strVal = String(value);
		if (strVal.length > 8) {
			return `${strVal.slice(0, 4)}...${strVal.slice(-4)}`;
		}
		return "****";
	}

	switch (control.type) {
		case "number":
			return typeof value === "number" ? value.toLocaleString() : String(value);

		case "boolean":
			return value ? "Yes" : "No";

		case "date":
			return value instanceof Date ? value.toLocaleDateString() : String(value);

		case "select":
			if (control.options) {
				const option = control.options.find(
					(opt) => opt.value === String(value),
				);
				if (option) return option.label;
			}
			return String(value);

		case "file":
			if (Array.isArray(value)) {
				return value
					.map((f) => (f as { name?: string }).name || "file")
					.join(", ");
			}
			return (value as { name?: string }).name || "file";

		default:
			return String(value);
	}
}
