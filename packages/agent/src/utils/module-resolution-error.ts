/** Classifies optional module absence without hiding broken dependencies. */
/** Node/Bun error codes emitted when a module cannot be resolved. */
function isModuleResolutionError(err: unknown): boolean {
  if (err == null) return false;
  const code = (err as { code?: unknown }).code;
  if (code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND") {
    return true;
  }
  const name = (err as { name?: unknown }).name;
  if (name === "ResolveMessage") return true;
  const message = (err as { message?: unknown }).message;
  if (typeof message === "string") {
    // Cover Bun's ResolveMessage and Node's loader text that don't set `code`.
    return (
      message.startsWith("Cannot find module") ||
      message.includes("Cannot find package") ||
      /Cannot find module ['"]/.test(message)
    );
  }
  return false;
}

/**
 * True only when the resolution failure is about the OPTIONAL PLUGIN PACKAGE
 * ITSELF being absent from the bundle — the EXPECTED mobile-bundle exclusion
 * (quiet debug + fallthrough).
 *
 * A present-but-broken plugin whose own top-level/transitive import is missing
 * ALSO reports `ERR_MODULE_NOT_FOUND` (e.g. `Cannot find package 'x' imported
 * from @elizaos/plugin-mcp/...`). Treating every module-resolution error as
 * "plugin absent" would silence exactly the drift this module exists to surface,
 * so we require the error to name the plugin specifier as the UNRESOLVED module
 * — not merely mention it as the importer. When the failing module isn't the
 * plugin package itself (a transitive dep), this returns false so the caller
 * escalates to an observable warning.
 */
export function isModuleNotFoundError(
  err: unknown,
  specifier: string,
): boolean {
  if (!isModuleResolutionError(err)) return false;

  const message = (err as { message?: unknown }).message;
  if (typeof message !== "string") return false;

  // Node/Bun phrase the failure as:
  //   Cannot find module '<unresolved>' [imported from '<importer>']
  //   Cannot find package '<unresolved>' imported from <importer>
  // We only treat it as a benign absence when the UNRESOLVED module (the quoted
  // name right after "Cannot find module/package") IS the plugin package itself
  // exactly. A missing sibling subpath means a present package is broken.
  // If the plugin merely appears as the
  // IMPORTER of some OTHER missing module, that's a broken transitive dep in a
  // PRESENT plugin -> drift, not absence.
  const unresolvedMatch = message.match(
    /Cannot find (?:module|package) ['"]([^'"]+)['"]/,
  );
  if (unresolvedMatch) {
    const unresolved = unresolvedMatch[1];
    return unresolved === specifier;
  }

  // Ambiguous diagnostics are failures, not evidence that an optional target
  // is absent. Never classify a mention of the importer as the missing target.
  return false;
}
