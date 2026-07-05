/**
 * Source-scanning gate enforcing the views-redesign de-chipping (#13588): views
 * carry designed empty states, never in-view suggestion chips or "create-X"
 * marketing CTAs. The agent suggests in chat (per-view proactive greeting
 * #13587) instead. Reads the src tree, no runtime — mirrors
 * `no-widget-chrome-gate.test.ts` so the decision can't silently regress.
 *
 * Two bans: (1) the deleted `ChatEmptyStateWithRecommendations` component may not
 * reappear as an import/JSX/type, and (2) the specific chat-prefill chip and
 * empty-state marketing strings its consumers rendered may not reappear. The
 * ban is on suggestions and marketing, NOT on genuinely functional controls
 * (real create forms, upload intake, backup/restore) — those keep their labels.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

// The removed component. Any occurrence — import, JSX tag, or type annotation —
// is a regression; it was deleted with its barrel exports in #13588.
const BANNED_COMPONENT = "ChatEmptyStateWithRecommendations";

// Removed empty-state suggestion/marketing strings. These are the chat-prefill
// chip labels and the trimmed empty-state marketing suffixes that #13588 struck.
// Matched literally (case-insensitive) against source so a re-introduced chip is
// caught even if it moves views. Functional-form labels (e.g. "Create new app")
// are intentionally NOT here — the ban is suggestions/marketing, not controls.
const BANNED_STRINGS: readonly string[] = [
  "What should I add to Knowledge?",
  "No secrets yet. Add an API key",
  "Ask a coding agent to refactor a file",
  "Dispatch a coding agent to fix a failing test",
  "Ask Eliza to fix a bug",
];

const SCAN_ROOTS = [
  join(import.meta.dirname, "components"),
  join(import.meta.dirname, "cloud"),
  join(import.meta.dirname, "cloud-ui"),
  // Sibling plugins whose views were de-chipped in the same change.
  join(import.meta.dirname, "../../../plugins/plugin-task-coordinator/src"),
  join(import.meta.dirname, "../../../plugins/plugin-wallet-ui/src"),
] as const;

function collectFiles(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (name === "node_modules" || name === "dist" || name === "__e2e__") {
      continue;
    }
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      collectFiles(full, out);
    } else if (
      /\.tsx?$/.test(name) &&
      !name.includes(".test.") &&
      !name.includes(".stories.")
    ) {
      out.push(full);
    }
  }
  return out;
}

const REPO_ROOT = dirname(dirname(dirname(import.meta.dirname)));
const rel = (file: string) =>
  file.slice(REPO_ROOT.length + 1).replace(/\\/g, "/");

describe("no view-suggestion-chips gate (#13588)", () => {
  const files = SCAN_ROOTS.flatMap((root) => collectFiles(root));

  it("finds source to scan", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it("the deleted ChatEmptyStateWithRecommendations component never reappears", () => {
    const offenders: string[] = [];
    for (const file of files) {
      readFileSync(file, "utf8")
        .split("\n")
        .forEach((line, i) => {
          if (line.includes(BANNED_COMPONENT)) {
            offenders.push(`${rel(file)}:${i + 1}`);
          }
        });
    }
    expect(
      offenders,
      `${BANNED_COMPONENT} was removed in #13588 (views carry designed empty ` +
        `states; the agent suggests in chat). It must not return:\n  ${offenders.join("\n  ")}`,
    ).toEqual([]);
  });

  it("removed in-view suggestion/marketing strings never reappear", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const lower = readFileSync(file, "utf8").toLowerCase();
      for (const banned of BANNED_STRINGS) {
        if (lower.includes(banned.toLowerCase())) {
          offenders.push(`${rel(file)} — "${banned}"`);
        }
      }
    }
    expect(
      offenders,
      `These in-view suggestion/marketing strings were removed in #13588. ` +
        `Empty states state what is empty and stay quiet; the agent offers ` +
        `next steps in chat:\n  ${offenders.join("\n  ")}`,
    ).toEqual([]);
  });
});
