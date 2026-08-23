/**
 * Defines fail-closed build policy for optional iOS app extensions.
 * Product builds omit the custom keyboard unless a v2 development build
 * explicitly enables it with the exact value `1`.
 */

export const IOS_KEYBOARD_EXTENSION_ENV =
  "ELIZA_IOS_KEYBOARD_EXTENSION_ENABLED";

/** Resolve the custom-keyboard build flag without accepting ambiguous values. */
export function readIosKeyboardExtensionBuildFlag(raw) {
  if (raw === undefined || raw === "" || raw === "0") return false;
  if (raw === "1") return true;
  throw new Error(
    `${IOS_KEYBOARD_EXTENSION_ENV} must be "0" or "1", received ${JSON.stringify(raw)}`,
  );
}

/** Resolve the custom-keyboard policy from a process-like environment. */
export function isIosKeyboardExtensionEnabled(env = process.env) {
  return readIosKeyboardExtensionBuildFlag(env[IOS_KEYBOARD_EXTENSION_ENV]);
}
