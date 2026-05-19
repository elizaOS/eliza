/**
 * cron-format — small, dependency-free helper that turns the most common
 * cron expressions into a friendly English description.
 *
 * Scope: 5-field cron (minute hour dom month dow). We don't try to handle
 * every possible expression — when an input doesn't match a recognised
 * pattern we fall back to returning the raw expression so the user at
 * least sees what's scheduled.
 *
 * Why no `cronstrue` dep: that package is ~50KB minified and pulls in a
 * full parser to cover edge cases the UI never surfaces. The Task editor
 * only offers a small set of presets plus a free-text input, so a
 * targeted formatter is enough.
 */
export interface CronPreset {
    label: string;
    expression: string;
}
/** Presets surfaced in the Task editor's recurring schedule picker. */
export declare const CRON_PRESETS: ReadonlyArray<CronPreset>;
/**
 * Returns a friendly description like "Every weekday at 9am" for a small
 * set of well-known cron shapes. Returns `null` for anything we don't
 * recognise — callers should fall back to displaying the raw expression.
 */
export declare function describeCron(expression: string): string | null;
/**
 * Format any schedule for display: prefer the friendly description, fall
 * back to the raw expression. Always returns a non-empty string.
 */
export declare function formatSchedule(expression: string): string;
//# sourceMappingURL=cron-format.d.ts.map