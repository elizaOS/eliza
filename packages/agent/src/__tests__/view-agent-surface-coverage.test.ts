/**
 * Coverage ratchet: every converted plugin view must register at least one
 * element with the agent surface (useAgentElement) so the floating pill can
 * address it. Guards against a view regressing to an unaddressable surface.
 *
 * lifeops is tracked as pending — its working tree currently carries an
 * unrelated refactor; it is converted separately.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const PLUGINS_DIR = path.resolve(here, "../../../../plugins");

/** Plugins whose view has been wired to the agent surface. */
const CONVERTED_PLUGINS = [
  "plugin-wallet-ui",
  "app-model-tester",
  "plugin-2004scape",
  "plugin-app-control",
  "plugin-clawville",
  "plugin-companion",
  "plugin-contacts",
  "plugin-defense-of-the-agents",
  "plugin-facewear",
  "plugin-feed",
  "plugin-hyperliquid-app",
  "plugin-hyperscape",
  "plugin-messages",
  "plugin-phone",
  "plugin-polymarket-app",
  "plugin-scape",
  "plugin-screenshare",
  "plugin-shopify-ui",
  "plugin-steward-app",
  "plugin-task-coordinator",
  "plugin-training",
  "plugin-trajectory-logger",
  "plugin-vincent",
  "plugin-lifeops",
] as const;

/** Views not yet converted — must be empty for the ratchet to be satisfied. */
const PENDING_PLUGINS: readonly string[] = [];

function walkTsx(dir: string): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      if (entry === "node_modules" || entry === "dist") continue;
      out.push(...walkTsx(full));
    } else if (entry.endsWith(".tsx") && !entry.endsWith(".test.tsx")) {
      out.push(full);
    }
  }
  return out;
}

function registersAgentElement(pluginDir: string): boolean {
  const srcDir = path.join(PLUGINS_DIR, pluginDir, "src");
  return walkTsx(srcDir).some((file) =>
    readFileSync(file, "utf8").includes("useAgentElement"),
  );
}

const UI_COMPONENTS_DIR = path.resolve(here, "../../../ui/src/components");

/**
 * Builtin shell views, made controllable via ShellViewAgentSurface (rather than
 * the bundle loader). Paths are relative to packages/ui/src/components. Each
 * must wrap its body in the bridge. (chat is intentionally absent — it is the
 * in-view-chat removal target, not a conversion.)
 */
const CONVERTED_BUILTIN_PAGES = [
  "pages/SettingsView",
  "pages/PluginsPageView",
  "pages/TrajectoriesView",
  "pages/MemoryViewerView",
  "pages/DatabasePageView",
  "pages/LogsView",
  "pages/AutomationsFeed",
  "character/CharacterEditor",
] as const;

function wrapsInShellBridge(pageFile: string): boolean {
  const file = path.join(UI_COMPONENTS_DIR, `${pageFile}.tsx`);
  try {
    return readFileSync(file, "utf8").includes("ShellViewAgentSurface");
  } catch {
    return false;
  }
}

/**
 * Additional standalone shell views. Each is either wrapped in the bridge or —
 * when it is a child rendered inside an already-wrapped parent — registers its
 * controls into the ancestor registry via useAgentElement (controls-only mode).
 */
const CONVERTED_SHELL_PAGES = [
  "pages/AppsPageView",
  "pages/ElizaOsAppsView",
  "pages/RelationshipsView",
  "pages/RuntimeView",
  "pages/SkillsView",
  "pages/StreamView",
  "pages/TasksPageView",
  "pages/BrowserWorkspaceView",
  "pages/SecretsView",
  "pages/ReleaseCenterView",
  "pages/HeartbeatsView",
  "pages/DocumentsView",
  "pages/ConfigPageView",
] as const;

function isAgentControllable(pageFile: string): boolean {
  const file = path.join(UI_COMPONENTS_DIR, `${pageFile}.tsx`);
  try {
    const src = readFileSync(file, "utf8");
    return (
      src.includes("ShellViewAgentSurface") || src.includes("useAgentElement")
    );
  } catch {
    return false;
  }
}

describe("agent-surface view coverage", () => {
  it.each(
    CONVERTED_PLUGINS,
  )("%s registers at least one agent-surface element", (plugin) => {
    expect(registersAgentElement(plugin)).toBe(true);
  });

  it.each(
    CONVERTED_BUILTIN_PAGES,
  )("builtin %s is wrapped in the agent-surface bridge", (page) => {
    expect(wrapsInShellBridge(page)).toBe(true);
  });

  it.each(
    CONVERTED_SHELL_PAGES,
  )("shell view %s is agent-controllable (bridge or registered controls)", (page) => {
    expect(isAgentControllable(page)).toBe(true);
  });

  it("has zero unconverted plugin views (lifeops now included)", () => {
    expect(PENDING_PLUGINS).toHaveLength(0);
  });
});
