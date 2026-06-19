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

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { VIEW_HERO_ICONS, renderViewHeroSvg } from "@elizaos/shared";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Per-view config. Hues are hand-spread across warm/jewel tones (orange, amber,
 * rose, magenta, violet, teal, green) so the catalog reads as a varied spectrum
 * while staying cohesive. None lands on pure blue (~210–250) as the dominant.
 */
const views = [
  { out: "plugins/app-model-tester/assets/hero.svg", id: "model-tester", label: "Model Tester", hue: 25, icon: VIEW_HERO_ICONS.modelTester },
  { out: "plugins/plugin-app-control/assets/hero.svg", id: "views", label: "Views", hue: 270, icon: VIEW_HERO_ICONS.views },
  { out: "plugins/plugin-blocker/assets/hero.svg", id: "focus", label: "Focus", hue: 348, icon: VIEW_HERO_ICONS.focus },
  { out: "plugins/plugin-calendar/assets/hero.svg", id: "calendar", label: "Calendar", hue: 12, icon: VIEW_HERO_ICONS.calendar },
  { out: "plugins/plugin-facewear/assets/hero-facewear.svg", id: "facewear", label: "Facewear", hue: 190, icon: VIEW_HERO_ICONS.headphones },
  { out: "plugins/plugin-facewear/assets/hero-smartglasses.svg", id: "smartglasses", label: "Smartglasses", hue: 300, icon: VIEW_HERO_ICONS.glasses },
  { out: "plugins/plugin-finances/assets/hero.svg", id: "finances", label: "Finances", hue: 150, icon: VIEW_HERO_ICONS.finances },
  { out: "plugins/plugin-goals/assets/hero.svg", id: "goals", label: "Goals", hue: 38, icon: VIEW_HERO_ICONS.goals },
  { out: "plugins/plugin-health/assets/hero.svg", id: "health", label: "Health", hue: 332, icon: VIEW_HERO_ICONS.health },
  { out: "plugins/plugin-inbox/assets/hero.svg", id: "inbox", label: "Inbox", hue: 168, icon: VIEW_HERO_ICONS.inbox },
  { out: "plugins/plugin-messages/assets/hero.svg", id: "messages", label: "Messages", hue: 256, icon: VIEW_HERO_ICONS.messages },
  { out: "plugins/plugin-relationships/assets/hero.svg", id: "relationships", label: "Relationships", hue: 286, icon: VIEW_HERO_ICONS.vectorBrowser },
  { out: "plugins/plugin-social-alpha/assets/hero.svg", id: "social-alpha", label: "Social Alpha", hue: 130, icon: VIEW_HERO_ICONS.socialAlpha },
  { out: "plugins/plugin-todos/assets/hero.svg", id: "todos", label: "Todos", hue: 52, icon: VIEW_HERO_ICONS.todos },
  { out: "plugins/plugin-vector-browser/assets/hero.svg", id: "vector-browser", label: "Vector Browser", hue: 286, icon: VIEW_HERO_ICONS.vectorBrowser },
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
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
