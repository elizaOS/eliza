/**
 * @module defaults
 * @description Default value application for forms and controls
 *
 * ## Purpose
 *
 * Form definitions can be quite minimal:
 *
 * ```typescript
 * { id: 'contact', controls: [{ key: 'email' }] }
 * ```
 *
 * This module fills in sensible defaults:
 *
 * ```typescript
 * {
 *   id: 'contact',
 *   name: 'Contact',           // Prettified from id
 *   version: 1,                // Default version
 *   status: 'active',          // Default status
 *   controls: [{
 *     key: 'email',
 *     label: 'Email',          // Prettified from key
 *     type: 'text',            // Default type
 *     required: false,         // Default required
 *     confirmThreshold: 0.8,   // Default confidence threshold
 *   }],
 *   ux: { ... },               // All UX defaults
 *   ttl: { ... },              // All TTL defaults
 *   nudge: { ... },            // All nudge defaults
 *   debug: false,              // Default debug off
 * }
 * ```
 *
 * ## When Defaults Apply
 *
 * Defaults are applied:
 *
 * 1. **At Registration**: When a form is registered via FormService
 * 2. **At Build**: When using FormBuilder.build()
 *
 * This ensures:
 * - Minimal definitions work correctly
 * - All optional fields have values
 * - Code can rely on values being present
 *
 * ## Default Values Philosophy
 *
 * Default values were chosen to be:
 *
 * - **Safe**: Won't cause unexpected behavior
 * - **User-Friendly**: Enable features users expect
 * - **Minimal**: Don't add unnecessary restrictions
 *
 * For example:
 * - TTL defaults are generous (14-90 days)
 * - UX features are enabled by default
 * - Required defaults to false (explicit opt-in)
 */

import type { FormControl, FormDefinition } from "./types";
import { FORM_CONTROL_DEFAULTS, FORM_DEFINITION_DEFAULTS } from "./types";

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
  return {
    // Required field (must be present)
    key: control.key!,
    // Derive label from key if not provided
    // WHY: User sees labels, default should be readable
    label: control.label || prettify(control.key!),
    // Default type is text (most common)
    type: control.type || FORM_CONTROL_DEFAULTS.type,
    // Default not required (explicit opt-in)
    // WHY: Safer to require opt-in for required fields
    required: control.required ?? FORM_CONTROL_DEFAULTS.required,
    // Default confidence threshold for auto-acceptance
    // WHY 0.8: High enough to be confident, low enough to be useful
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
  return {
    // Required fields
    id: form.id!,
    // Derive name from id if not provided
    name: form.name || prettify(form.id!),
    // Default version for schema tracking
    version: form.version ?? FORM_DEFINITION_DEFAULTS.version,
    // Default status is active
    status: form.status ?? FORM_DEFINITION_DEFAULTS.status,
    // Apply defaults to all controls
    controls: (form.controls || []).map(applyControlDefaults),

    // UX defaults - enable helpful features by default
    // WHY enable by default: Better user experience out of the box
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

    // TTL defaults - generous retention
    // WHY generous: Better to keep data too long than lose user work
    ttl: {
      minDays: form.ttl?.minDays ?? FORM_DEFINITION_DEFAULTS.ttl.minDays,
      maxDays: form.ttl?.maxDays ?? FORM_DEFINITION_DEFAULTS.ttl.maxDays,
      effortMultiplier:
        form.ttl?.effortMultiplier ??
        FORM_DEFINITION_DEFAULTS.ttl.effortMultiplier,
    },

    // Nudge defaults - helpful but not annoying
    nudge: {
      enabled: form.nudge?.enabled ?? FORM_DEFINITION_DEFAULTS.nudge.enabled,
      afterInactiveHours:
        form.nudge?.afterInactiveHours ??
        FORM_DEFINITION_DEFAULTS.nudge.afterInactiveHours,
      maxNudges:
        form.nudge?.maxNudges ?? FORM_DEFINITION_DEFAULTS.nudge.maxNudges,
      message: form.nudge?.message,
    },

    // Debug defaults to off for performance
    debug: form.debug ?? FORM_DEFINITION_DEFAULTS.debug,

    // Spread remaining properties (override defaults)
    ...form,
  };
}

/**
 * Convert snake_case or kebab-case to Title Case.
 *
 * Used to generate human-readable labels from field keys
 * and form names from form IDs.
 *
 * @example
 * prettify('first_name')    // "First Name"
 * prettify('email-address') // "Email Address"
 * prettify('userId')        // "UserId" (camelCase preserved)
 *
 * @param key - The key to prettify
 * @returns Human-readable title case string
 */
export function prettify(key: string): string {
  return (
    key
      // Replace underscores and hyphens with spaces
      .replace(/[-_]/g, " ")
      // Capitalize first letter of each word
      .replace(/\b\w/g, (c) => c.toUpperCase())
  );
}
