/**
 * Shared string-escaping leaf utilities for the mobile build orchestrator.
 *
 * These are pure, dependency-free helpers used by the manifest/plist/gradle
 * transformer modules and by the build spine. They live in their own leaf
 * module so the transformer modules can import them without creating a cycle
 * back into `run-mobile-build.mjs`.
 */

/** Escape XML text content (`&`, `<`, `>`) for safe insertion into a node. */
export function escapeXmlText(value) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** Escape a string for literal use inside a `RegExp`. */
export function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
