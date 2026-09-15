/**
 * Resolves the optional packaged skill bundle during host startup. A deployment
 * may omit the package, but an installed bundle's configuration or evaluation
 * failure must reach the boot boundary instead of selecting another skill set.
 */
function isResolutionAbsence(
  error: unknown,
): error is { code: string; message: string } {
  // Bun's ResolveMessage is not an Error instance.
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "ERR_MODULE_NOT_FOUND" ||
      error.code === "MODULE_NOT_FOUND") &&
    "message" in error &&
    typeof error.message === "string"
  );
}

export async function resolveBundledSkillsDir(): Promise<string | null> {
  let skills: typeof import("@elizaos/skills");
  try {
    // Keep the literal import visible to mobile bundlers.
    skills = await import("@elizaos/skills");
  } catch (error) {
    // error-policy:J4 Only absence of the optional package disables bundled skills.
    if (
      isResolutionAbsence(error) &&
      /Cannot find (?:module|package) ['"]@elizaos\/skills['"]/.test(
        error.message,
      )
    ) {
      try {
        import.meta.resolve("@elizaos/skills/package.json");
      } catch (resolutionError) {
        // error-policy:J4 A present manifest distinguishes a broken entry point from package absence.
        if (isResolutionAbsence(resolutionError)) return null;
      }
    }
    throw error;
  }
  return skills.getSkillsDir();
}
