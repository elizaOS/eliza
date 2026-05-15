/**
 * Agent Skills Types
 *
 * Implements the Agent Skills specification from agentskills.io
 * with Otto compatibility extensions.
 *
 * @see https://agentskills.io/specification
 */
// ============================================================
// CONSTANTS
// ============================================================
/** Maximum length for skill name */
export const SKILL_NAME_MAX_LENGTH = 64;
/** Maximum length for skill description */
export const SKILL_DESCRIPTION_MAX_LENGTH = 1024;
/** Maximum length for compatibility field */
export const SKILL_COMPATIBILITY_MAX_LENGTH = 500;
/** Recommended maximum body length (tokens) */
export const SKILL_BODY_RECOMMENDED_TOKENS = 5000;
/** Pattern for valid skill names */
export const SKILL_NAME_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
/**
 * Source precedence values for ordering.
 */
export const SKILL_SOURCE_PRECEDENCE = {
    workspace: 5,
    managed: 4,
    bundled: 3,
    plugin: 2,
    extra: 1,
};
//# sourceMappingURL=types.js.map