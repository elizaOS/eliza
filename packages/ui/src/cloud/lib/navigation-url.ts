/**
 * Compatibility re-export. The scheme allowlist now lives in the shared UI
 * utils (`utils/navigation-url.ts`) so the platform-level navigation helpers
 * (`utils/openExternalUrl.ts`) can enforce it without a utils → cloud import;
 * existing cloud/lib import paths keep working.
 */
export { isSafeNavigationUrl } from "../../utils/navigation-url";
