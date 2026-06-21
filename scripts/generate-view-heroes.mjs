#!/usr/bin/env node
/**
 * Generate clean, brand-consistent SVG hero images for plugin views that lack
 * one. Heroes are probed at request time from `<pluginDir>/assets/hero.<ext>`
 * by `packages/agent/src/api/views-registry.ts` (`.svg` is a supported hero
 * extension). All existing real heroes are 1024x1024.
 *
 * The art itself (frame, palette, icon glyphs) is the shared, single source of
 * truth in `@elizaos/shared` (`view-hero-art.ts`) — the same generator the
 * agent uses for its runtime hero fallback and that view scaffolding uses to
 * seed a new plugin's icon. This script only owns the per-view config (which
 * plugin, hue, and glyph) and writes the committed asset files.
 *
 * Output is deterministic: re-running produces byte-identical files. Run with
 * `node scripts/generate-view-heroes.mjs` (requires `@elizaos/shared` built).
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderViewHeroSvg, VIEW_HERO_ICONS } from "@elizaos/shared";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

/**
 * Discover every plugin that declares an Eliza app surface (`elizaos.app` in its
 * package.json) by scanning the plugins manifest — the same source the view
 * catalog reads — so the generator can never silently omit a view-bearing
 * plugin. Returns the plugin dir names (e.g. "plugin-calendar").
 */
function scanAppPluginDirs() {
  const pluginsRoot = path.join(repoRoot, "plugins");
  if (!existsSync(pluginsRoot)) return [];
  const dirs = [];
  for (const name of readdirSync(pluginsRoot)) {
    const manifestPath = path.join(pluginsRoot, name, "package.json");
    if (!existsSync(manifestPath)) continue;
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      if (manifest?.elizaos?.app) dirs.push(name);
    } catch {
      // Unparseable manifest — skip; not a regression we own here.
    }
  }
  return dirs.sort();
}

/** True when a plugin dir already ships a hero asset (svg or png). */
function pluginHasHeroAsset(pluginDir) {
  const assetsDir = path.join(repoRoot, "plugins", pluginDir, "assets");
  if (!existsSync(assetsDir)) return false;
  return readdirSync(assetsDir).some((f) => /^hero.*\.(svg|png)$/.test(f));
}

/**
 * Per-view config. Hues are hand-spread across warm/jewel tones (orange, amber,
 * rose, magenta, violet, teal, green) so the catalog reads as a varied spectrum
 * while staying cohesive. None lands on pure blue (~210–250) as the dominant.
 */
const views = [
  {
    out: "plugins/app-model-tester/assets/hero.svg",
    id: "model-tester",
    label: "Model Tester",
    hue: 25,
    icon: VIEW_HERO_ICONS.modelTester,
  },
  {
    out: "plugins/plugin-app-control/assets/hero.svg",
    id: "views",
    label: "Views",
    hue: 270,
    icon: VIEW_HERO_ICONS.views,
  },
  {
    out: "plugins/plugin-blocker/assets/hero.svg",
    id: "focus",
    label: "Focus",
    hue: 348,
    icon: VIEW_HERO_ICONS.focus,
  },
  {
    out: "plugins/plugin-calendar/assets/hero.svg",
    id: "calendar",
    label: "Calendar",
    hue: 12,
    icon: VIEW_HERO_ICONS.calendar,
  },
  {
    out: "plugins/plugin-facewear/assets/hero-facewear.svg",
    id: "facewear",
    label: "Facewear",
    hue: 190,
    icon: VIEW_HERO_ICONS.headphones,
  },
  {
    out: "plugins/plugin-facewear/assets/hero-smartglasses.svg",
    id: "smartglasses",
    label: "Smartglasses",
    hue: 300,
    icon: VIEW_HERO_ICONS.glasses,
  },
  {
    out: "plugins/plugin-finances/assets/hero.svg",
    id: "finances",
    label: "Finances",
    hue: 150,
    icon: VIEW_HERO_ICONS.finances,
  },
  {
    out: "plugins/plugin-goals/assets/hero.svg",
    id: "goals",
    label: "Goals",
    hue: 38,
    icon: VIEW_HERO_ICONS.goals,
  },
  {
    out: "plugins/plugin-health/assets/hero.svg",
    id: "health",
    label: "Health",
    hue: 332,
    icon: VIEW_HERO_ICONS.health,
  },
  {
    out: "plugins/plugin-inbox/assets/hero.svg",
    id: "inbox",
    label: "Inbox",
    hue: 168,
    icon: VIEW_HERO_ICONS.inbox,
  },
  {
    out: "plugins/plugin-messages/assets/hero.svg",
    id: "messages",
    label: "Messages",
    hue: 256,
    icon: VIEW_HERO_ICONS.messages,
  },
  {
    out: "plugins/plugin-relationships/assets/hero.svg",
    id: "relationships",
    label: "Relationships",
    hue: 286,
    icon: VIEW_HERO_ICONS.vectorBrowser,
  },
  {
    out: "plugins/plugin-social-alpha/assets/hero.svg",
    id: "social-alpha",
    label: "Social Alpha",
    hue: 130,
    icon: VIEW_HERO_ICONS.socialAlpha,
  },
  {
    out: "plugins/plugin-todos/assets/hero.svg",
    id: "todos",
    label: "Todos",
    hue: 52,
    icon: VIEW_HERO_ICONS.todos,
  },
  {
    out: "plugins/plugin-vector-browser/assets/hero.svg",
    id: "vector-browser",
    label: "Vector Browser",
    hue: 286,
    icon: VIEW_HERO_ICONS.vectorBrowser,
  },
];

async function main() {
  const written = [];
  for (const view of views) {
    const svg = renderViewHeroSvg({
      id: view.id,
      hue: view.hue,
      iconSvg: view.icon,
      label: view.label,
    });
    const absPath = path.resolve(repoRoot, view.out);
    await mkdir(path.dirname(absPath), { recursive: true });
    await writeFile(absPath, svg, "utf8");
    written.push({ path: view.out, bytes: Buffer.byteLength(svg, "utf8") });
  }

  for (const entry of written) {
    console.log(`${String(entry.bytes).padStart(6)}  ${entry.path}`);
  }
  console.log(`\nWrote ${written.length} hero SVG files.`);

  // Coverage, sourced from the manifest scan (#8796): every plugin that
  // declares an Eliza app surface must ship a hero asset — either generated
  // above (curated hue/icon) or committed directly. A plugin without one is a
  // gap the catalog would render as an icon-only fallback.
  const curatedDirs = new Set(
    views.map((v) => v.out.split("/")[1]).filter(Boolean),
  );
  const appPlugins = scanAppPluginDirs();
  const missing = appPlugins.filter(
    (dir) => !pluginHasHeroAsset(dir) && !curatedDirs.has(dir),
  );
  console.log(
    `\nManifest scan: ${appPlugins.length} app plugins, ${appPlugins.length - missing.length} with a hero asset.`,
  );
  if (missing.length > 0) {
    console.warn(
      `\n⚠️  ${missing.length} app plugin(s) declare a surface but ship no hero asset:\n${missing
        .map((d) => `  - plugins/${d}`)
        .join(
          "\n",
        )}\nAdd a curated entry above or commit plugins/<name>/assets/hero.svg.`,
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
