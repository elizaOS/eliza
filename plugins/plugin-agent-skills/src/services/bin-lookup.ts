/**
 * PATH binary lookup shared by skill eligibility checks and dependency
 * installation.
 *
 * The probed names come from skill frontmatter (`requires.bins`,
 * `install[].bins`), which is registry-controlled and therefore untrusted.
 * Two invariants keep that input safe: names must match
 * `SKILL_BIN_NAME_PATTERN` (bare executable names — no whitespace, shell
 * metacharacters, path separators, or leading dashes), and the lookup runs
 * `which`/`where` in argv form with no shell, so a name can never be
 * interpreted as shell syntax even if the allowlist is bypassed.
 *
 * @module services/bin-lookup
 */

import { SKILL_BIN_NAME_PATTERN } from "../types";

/**
 * Check whether a binary exists in PATH.
 *
 * Returns false for names that fail the allowlist (they can never be
 * legitimate executables) and for any probe failure, so callers treat
 * unverifiable names as absent and the skill reports as ineligible.
 */
export async function binaryExistsInPath(name: string): Promise<boolean> {
	if (typeof name !== "string" || !SKILL_BIN_NAME_PATTERN.test(name)) {
		return false;
	}
	try {
		const { execFileSync } = await import("node:child_process");
		// argv form, no shell: `name` is passed verbatim as a single argument.
		// `where` is a real executable on Windows (System32\where.exe), so it
		// resolves without a shell there as well.
		const probe = process.platform === "win32" ? "where.exe" : "which";
		execFileSync(probe, [name], {
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
		});
		return true;
	} catch {
		// error-policy:J4 a failed probe (binary absent, non-zero exit, or no
		// which/where on the host) marks the binary as missing; the skill
		// surfaces a distinct ineligible state with an install suggestion.
		return false;
	}
}
