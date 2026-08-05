/**
 * Settings for ClawdBrowser tools.md catalog plugin.
 *
 * CLAWDBROWSER_TOOLS_MD — absolute or relative path to tools.md
 * CLAWDBROWSER_ROOT     — ClawdBrowser checkout root (tools.md resolved as <root>/tools.md)
 * CLAWDBROWSER_API_URL  — optional base URL for future live tool relay (not required for catalog)
 */

import { existsSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";

export type ClawdBrowserConfig = {
  toolsMdPath: string | null;
  root: string | null;
  apiUrl: string | null;
  enabled: boolean;
};

function expand(path: string): string {
  const t = path.trim();
  if (!t) return t;
  if (t === "~") return homedir();
  if (t.startsWith("~/") || t.startsWith("~\\")) {
    return resolve(homedir(), t.slice(2));
  }
  if (isAbsolute(t)) return t;
  return resolve(process.cwd(), t);
}

const DEFAULT_CANDIDATES = [
  "/Users/8bit/ClawdBrowser/tools.md",
  join(homedir(), "ClawdBrowser", "tools.md"),
];

/**
 * Resolve the tools.md path from runtime settings / env.
 */
export function resolveToolsMdPath(
  getSetting: (key: string) => string | undefined | null,
): string | null {
  const explicit =
    getSetting("CLAWDBROWSER_TOOLS_MD") ||
    getSetting("CLAWD_BROWSER_TOOLS_MD") ||
    process.env.CLAWDBROWSER_TOOLS_MD ||
    process.env.CLAWD_BROWSER_TOOLS_MD;

  if (explicit?.trim()) {
    const p = expand(explicit);
    return existsSync(p) ? p : p; // return even if missing so diagnostics are clear
  }

  const root =
    getSetting("CLAWDBROWSER_ROOT") ||
    getSetting("CLAWD_BROWSER_ROOT") ||
    process.env.CLAWDBROWSER_ROOT ||
    process.env.CLAWD_BROWSER_ROOT;

  if (root?.trim()) {
    const candidate = join(expand(root), "tools.md");
    if (existsSync(candidate)) return candidate;
  }

  for (const c of DEFAULT_CANDIDATES) {
    if (existsSync(c)) return c;
  }
  return null;
}

export function readClawdBrowserConfig(
  getSetting: (key: string) => string | undefined | null = (k) =>
    process.env[k],
): ClawdBrowserConfig {
  const toolsMdPath = resolveToolsMdPath(getSetting);
  const rootRaw =
    getSetting("CLAWDBROWSER_ROOT") || process.env.CLAWDBROWSER_ROOT || null;
  const apiUrl =
    getSetting("CLAWDBROWSER_API_URL") ||
    process.env.CLAWDBROWSER_API_URL ||
    null;
  const disabled =
    (getSetting("CLAWDBROWSER_ENABLED") || process.env.CLAWDBROWSER_ENABLED) ===
    "false";

  return {
    toolsMdPath,
    root: rootRaw ? expand(rootRaw) : null,
    apiUrl: apiUrl?.trim() || null,
    enabled: !disabled,
  };
}
