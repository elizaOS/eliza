/**
 * Probes for the GNU userland the repository's CI workflow snippets assume.
 *
 * Workflow-contract tests execute verbatim bash extracted from .github
 * workflows. That bash targets GitHub's Linux runners — GNU `sed -i` with no
 * backup suffix, bash >= 4 expansions like `${var,,}` — which macOS's BSD sed
 * and /bin/bash 3.2 cannot run (bash 3.2 aborts on the expansion, silently
 * zeroing every gate the snippet was meant to enforce). Consumers resolve the
 * needed tool here and conditional-skip their executed cases when it is
 * absent, so the lane stays honest on BSD hosts without weakening Linux/CI
 * coverage. A `brew install gnu-sed` / `brew install bash` restores full
 * local coverage.
 */

import { execFileSync } from "node:child_process";

/**
 * Resolve a GNU sed command name (`sed` on Linux, `gsed` from Homebrew's
 * gnu-sed on macOS), or null when none is reachable.
 *
 * @returns {string | null}
 */
export function resolveGnuSed() {
  for (const candidate of ["sed", "gsed"]) {
    try {
      const out = execFileSync(candidate, ["--version"], { encoding: "utf8" });
      if (out.includes("GNU sed")) return candidate;
    } catch {
      // error-policy:J3 a missing or non-GNU candidate is the explicit
      // "unavailable" signal this probe exists to produce; the caller
      // receives null and must skip, never fake, GNU-dependent coverage.
    }
  }
  return null;
}

/**
 * Resolve a bash >= 4 command (supports `${var,,}` case expansion): `bash` on
 * PATH when modern, else Homebrew's install locations. Returns null when only
 * pre-4 bash (macOS /bin/bash 3.2) is reachable.
 *
 * @returns {string | null}
 */
export function resolveGnuBash() {
  for (const candidate of [
    "bash",
    "/opt/homebrew/bin/bash",
    "/usr/local/bin/bash",
  ]) {
    try {
      const out = execFileSync(
        candidate,
        // biome-ignore lint/suspicious/noTemplateCurlyInString: ${probe,,} is bash case-expansion syntax under probe, not a JS template placeholder.
        ["-c", 'probe=Aa; printf %s "${probe,,}"'],
        { encoding: "utf8" },
      );
      if (out === "aa") return candidate;
    } catch {
      // error-policy:J3 a missing candidate or a bash 3.2 "bad substitution"
      // abort is the explicit "unavailable" signal this probe exists to
      // produce; the caller receives null and must skip, never fake,
      // modern-bash coverage.
    }
  }
  return null;
}
