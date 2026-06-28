/**
 * Strips a versioned snapshot suffix from a model id when the suffix looks
 * unambiguous: dated (`-20240605`, `-2024-06-05`), labeled (`-latest`,
 * `-preview`, `-beta`), or numeric (`-001`, `-1234`).
 *
 * **Why:** BitRouter's catalog lists models under their snapshot ids
 * (`google/gemini-2.0-flash-001`, `openai/gpt-4o-2024-11-20`) while clients
 * routinely send the unsuffixed canonical id (`google/gemini-2.0-flash`,
 * `openai/gpt-4o`). Without a second index entry under the base id, pricing
 * lookup throws "Pricing unavailable" even though the inference call itself
 * succeeds at BitRouter (which performs its own alias resolution).
 *
 * **Numeric-suffix safety rail:** for `-NNN` patterns we require at least two
 * dash-separated segments to remain after the slash so `openai/gpt-4` does not
 * collapse to `openai/gpt`. Date and labelled suffixes are unambiguous so
 * `openai/o1-2024-12-17` still strips to `openai/o1`.
 *
 * Returns the stripped id, or `null` if no rule applies or the result would be
 * degenerate (empty, or just a `provider/` prefix).
 */
export function stripVersionedSnapshotSuffix(modelId: string): string | null {
  const datedOrLabelledPatterns = [
    /-\d{4}-\d{2}-\d{2}$/, // ISO date: -2024-06-05
    /-(?:19|20)\d{6}$/, // compact date: -20240605 (year-anchored so unrelated 8-digit run-ids aren't stripped)
    /-latest$/,
    /-preview$/,
    /-beta$/,
  ];

  for (const pattern of datedOrLabelledPatterns) {
    if (!pattern.test(modelId)) continue;
    const stripped = modelId.replace(pattern, "");
    if (stripped.length === 0 || stripped.endsWith("/")) return null;
    return stripped;
  }

  const numericPattern = /-\d{1,4}$/;
  if (numericPattern.test(modelId)) {
    const stripped = modelId.replace(numericPattern, "");
    if (stripped.length === 0 || stripped.endsWith("/")) return null;
    const slashIdx = stripped.indexOf("/");
    const afterSlash = slashIdx === -1 ? stripped : stripped.slice(slashIdx + 1);
    if (afterSlash.split("-").length < 2) return null;
    return stripped;
  }

  return null;
}
