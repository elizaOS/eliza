/**
 * Resolves workspace instructions for the eliza-code ACP child. Project-owned
 * manuals remain verbatim; the orchestrator's known scaffold is represented by
 * a compact always-needed contract and left on disk for on-demand bridge detail.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

const ORCHESTRATOR_MANUAL_HEADING =
  "# Eliza coding sub-agent — operating manual";

export const COMPACT_ORCHESTRATOR_MANUAL = `Eliza coding sub-agent contract:
- This ACP session is non-interactive. Never ask a question and wait, block on input, or tell the user to run a command. Make the best safe choice and continue; if genuinely blocked, report one concise DECISION: line.
- The supplied workspace directory is authoritative. Keep every write inside it, use the provided coding tools, finish the requested work, and verify the real result before replying.
- Do not push to remotes or open pull requests. Never print or commit secrets.
- The final reply is relayed into chat: lead with the deliverable or exact output, stay concise, and omit absolute paths, workspace/session ids, raw tool payloads, and process narration.
- The full parent-context, credential, skill, and broker bridge reference remains in AGENTS.md/CLAUDE.md. Read that file only if this task actually needs one of those bridges.`;

/**
 * Compact only the exact orchestrator-owned manual shape. A repository's own
 * instructions are an authoritative input and must reach the child verbatim.
 */
export function workspaceManualForPrompt(manual: string): string {
  const trimmed = manual.trim();
  if (!trimmed.startsWith(ORCHESTRATOR_MANUAL_HEADING)) return trimmed;
  return COMPACT_ORCHESTRATOR_MANUAL;
}

/** Read the first workspace instruction file using the same precedence as ACP backends. */
export async function readWorkspaceManualForPrompt(
  cwd?: string,
): Promise<string> {
  if (!cwd) return "";
  for (const name of ["AGENTS.md", "CLAUDE.md"]) {
    try {
      const text = await readFile(join(cwd, name), "utf8");
      if (text.trim()) return workspaceManualForPrompt(text);
    } catch (error) {
      // error-policy:J4 Missing instructions are an expected unavailable state;
      // permission and filesystem failures must still stop session setup.
      if (
        !(error instanceof Error) ||
        !("code" in error) ||
        error.code !== "ENOENT"
      ) {
        throw error;
      }
    }
  }
  return "";
}
