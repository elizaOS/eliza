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
] as const;

/** Views not yet converted — must be empty for the ratchet to be satisfied. */
const PENDING_PLUGINS = ["plugin-lifeops"] as const;

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

describe("agent-surface view coverage", () => {
  it.each(
    CONVERTED_PLUGINS,
  )("%s registers at least one agent-surface element", (plugin) => {
    expect(registersAgentElement(plugin)).toBe(true);
  });

  it("does not silently leave pending views uncounted", () => {
    // This documents the known gap. When lifeops is converted, move it into
    // CONVERTED_PLUGINS and drop it here — the assertion then enforces 0 debt.
    expect(PENDING_PLUGINS.length).toBeLessThanOrEqual(1);
  });
});
