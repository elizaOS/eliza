/**
 * @module defaults
 * @description Default value application for forms and controls
 */

import type { FormControl, FormDefinition } from "./types.ts";
import { FORM_CONTROL_DEFAULTS, FORM_DEFINITION_DEFAULTS } from "./types.ts";

/**
 * Apply defaults to a FormControl.
 *
 * Ensures all optional fields have values.
 *
 * @param control - Partial control to complete
 * @returns Complete FormControl with all defaults applied
 */
export function applyControlDefaults(
	control: Partial<FormControl>,
): FormControl {
	const key = control.key;
	if (!key) {
		throw new Error("Control key is required");
	}

	return {
		// Required field (must be present)
		key,
		// Derive label from key if not provided
		label: control.label || prettify(key),
		// Default type is text (most common)
		type: control.type || FORM_CONTROL_DEFAULTS.type,
		// Default not required (explicit opt-in)
		required: control.required ?? FORM_CONTROL_DEFAULTS.required,
		// Default confidence threshold for auto-acceptance
		confirmThreshold:
			control.confirmThreshold ?? FORM_CONTROL_DEFAULTS.confirmThreshold,
		// Spread remaining properties (override defaults)
		...control,
	};
}

/**
 * Apply defaults to a FormDefinition.
 *
 * Ensures all optional fields have values and applies
 * defaults to all controls.
 *
 * @param form - Partial form to complete
 * @returns Complete FormDefinition with all defaults applied
 */
export function applyFormDefaults(
	form: Partial<FormDefinition>,
): FormDefinition {
	const id = form.id;
	if (!id) {
		throw new Error("Form id is required");
	}

	return {
		// Required fields
		id,
		// Derive name from id if not provided
		name: form.name || prettify(id),
		// Default version for schema tracking
		version: form.version ?? FORM_DEFINITION_DEFAULTS.version,
		// Default status is active
		status: form.status ?? FORM_DEFINITION_DEFAULTS.status,
		// Apply defaults to all controls
		controls: (form.controls || []).map(applyControlDefaults),

		// UX defaults
		ux: {
			allowUndo: form.ux?.allowUndo ?? FORM_DEFINITION_DEFAULTS.ux.allowUndo,
			allowSkip: form.ux?.allowSkip ?? FORM_DEFINITION_DEFAULTS.ux.allowSkip,
			maxUndoSteps:
				form.ux?.maxUndoSteps ?? FORM_DEFINITION_DEFAULTS.ux.maxUndoSteps,
			showExamples:
				form.ux?.showExamples ?? FORM_DEFINITION_DEFAULTS.ux.showExamples,
			showExplanations:
				form.ux?.showExplanations ??
				FORM_DEFINITION_DEFAULTS.ux.showExplanations,
			allowAutofill:
				form.ux?.allowAutofill ?? FORM_DEFINITION_DEFAULTS.ux.allowAutofill,
		},

		// TTL defaults
		ttl: {
			minDays: form.ttl?.minDays ?? FORM_DEFINITION_DEFAULTS.ttl.minDays,
			maxDays: form.ttl?.maxDays ?? FORM_DEFINITION_DEFAULTS.ttl.maxDays,
			effortMultiplier:
				form.ttl?.effortMultiplier ??
				FORM_DEFINITION_DEFAULTS.ttl.effortMultiplier,
		},

		// Nudge defaults
		nudge: {
			enabled: form.nudge?.enabled ?? FORM_DEFINITION_DEFAULTS.nudge.enabled,
			afterInactiveHours:
				form.nudge?.afterInactiveHours ??
				FORM_DEFINITION_DEFAULTS.nudge.afterInactiveHours,
			maxNudges:
				form.nudge?.maxNudges ?? FORM_DEFINITION_DEFAULTS.nudge.maxNudges,
			message: form.nudge?.message,
		},

		// Debug defaults to off
		debug: form.debug ?? FORM_DEFINITION_DEFAULTS.debug,

		// Spread remaining properties (override defaults)
		...form,
	};
}

/**
 * Convert snake_case or kebab-case to Title Case.
 *
 * @param key - The key to prettify
 * @returns Human-readable title case string
 */
export function prettify(key: string): string {
	return key.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
