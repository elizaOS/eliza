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
 * seed a new plugin's icon. This script owns curated fallback config and checks
 * the full manifest-derived app catalog so hero omissions cannot silently ship.
 *
 * Output is deterministic: re-running produces byte-identical files. Run with
 * `node scripts/generate-view-heroes.mjs` (requires `@elizaos/shared` built).
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderViewHeroSvg, VIEW_HERO_ICONS } from "@elizaos/shared";

export const DEFAULT_REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

export function parseArgs(argv = process.argv.slice(2)) {
  const options = {
    repoRoot: DEFAULT_REPO_ROOT,
    dryRun: false,
    check: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--check") {
      options.check = true;
    } else if (arg.startsWith("--repo-root=")) {
      const val = arg.slice("--repo-root=".length).trim();
      if (!val) {
        throw new Error(
          "[generate-view-heroes] --repo-root requires a directory path",
        );
      }
      options.repoRoot = path.resolve(val);
    } else if (arg === "--repo-root") {
      const next = argv[index + 1];
      if (!next || next.startsWith("-")) {
        throw new Error(
          "[generate-view-heroes] --repo-root requires a directory path",
        );
      }
      options.repoRoot = path.resolve(next);
      index += 1;
    } else {
      throw new Error(`[generate-view-heroes] Unknown option: ${arg}`);
    }
  }

  return options;
}

export function printHelp() {
  console.log(`Usage: node scripts/generate-view-heroes.mjs [options]

Generate clean, brand-consistent SVG hero images for plugin views.

Options:
  --repo-root=<path>  Repository root directory (default: workspace root)
  --dry-run           Preview SVG generation without modifying files on disk
  --check             Verify all app plugins ship a hero asset without generating
  --help, -h          Show this help message`);
}

/**
 * Discover every plugin that declares an Eliza app surface (`elizaos.app` in its
 * package.json) by scanning the plugins manifest — the same source the view
 * catalog reads — so the generator can never silently omit a view-bearing
 * plugin. Returns the plugin dir names (e.g. "plugin-calendar").
 */
export function scanAppPluginDirs(repoRoot = DEFAULT_REPO_ROOT) {
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
export function pluginHasHeroAsset(pluginDir, repoRoot = DEFAULT_REPO_ROOT) {
  const assetsDir = path.join(repoRoot, "plugins", pluginDir, "assets");
  if (!existsSync(assetsDir)) return false;
  return readdirSync(assetsDir).some((f) => /^hero.*\.(svg|png)$/.test(f));
}

/**
 * Curated fallback config. The manifest coverage check below is the source of
 * truth for completeness; this list controls generated art for app plugins that
 * need a committed fallback hero.
 */
export const views = [
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
    out: "plugins/plugin-documents/assets/hero.svg",
    id: "documents",
    label: "Documents",
    hue: 190,
    icon: VIEW_HERO_ICONS.todos,
  },
  {
    out: "plugins/plugin-finances/assets/hero.svg",
    id: "finances",
    label: "Finances",
    hue: 150,
    icon: VIEW_HERO_ICONS.finances,
  },
  {
    out: "plugins/plugin-form/assets/hero.svg",
    id: "form",
    label: "Form",
    hue: 25,
    icon: VIEW_HERO_ICONS.todos,
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
    out: "plugins/plugin-maps/assets/hero.svg",
    id: "maps",
    label: "Maps",
    hue: 24,
    icon: VIEW_HERO_ICONS.vectorBrowser,
  },
  {
    out: "plugins/plugin-native-settings/assets/hero.svg",
    id: "device-settings",
    label: "Device Settings",
    hue: 96,
    icon: VIEW_HERO_ICONS.views,
  },
  {
    out: "plugins/plugin-personal-assistant/assets/hero.svg",
    id: "assistant",
    label: "Assistant",
    hue: 280,
    icon: VIEW_HERO_ICONS.views,
  },
  {
    out: "plugins/plugin-relationships/assets/hero.svg",
    id: "relationships",
    label: "Relationships",
    hue: 286,
    icon: VIEW_HERO_ICONS.vectorBrowser,
  },
  {
    out: "plugins/plugin-todos/assets/hero.svg",
    id: "todos",
    label: "Todos",
    hue: 52,
    icon: VIEW_HERO_ICONS.todos,
  },
];

export async function main(args = process.argv.slice(2)) {
  const options = parseArgs(args);
  if (options.help) {
    printHelp();
    return { writtenCount: 0, missingCount: 0, help: true };
  }

  const repoRoot = options.repoRoot;
  const written = [];

  if (!options.check) {
    for (const view of views) {
      const svg = renderViewHeroSvg({
        id: view.id,
        hue: view.hue,
        iconSvg: view.icon,
        label: view.label,
      });
      const absPath = path.resolve(repoRoot, view.out);
      if (!options.dryRun) {
        await mkdir(path.dirname(absPath), { recursive: true });
        await writeFile(absPath, svg, "utf8");
      }
      written.push({ path: view.out, bytes: Buffer.byteLength(svg, "utf8") });
    }

    for (const entry of written) {
      console.log(`${String(entry.bytes).padStart(6)}  ${entry.path}`);
    }
    console.log(
      `\n${options.dryRun ? "Would write" : "Wrote"} ${written.length} hero SVG files.`,
    );
  }

  const curatedDirs = new Set(
    views.map((v) => v.out.split("/")[1]).filter(Boolean),
  );
  const appPlugins = scanAppPluginDirs(repoRoot);
  const missing = appPlugins.filter(
    (dir) => !pluginHasHeroAsset(dir, repoRoot) && !curatedDirs.has(dir),
  );

  console.log(
    `\nManifest scan: ${appPlugins.length} app plugins, ${appPlugins.length - missing.length} with a hero asset.`,
  );
  if (missing.length > 0) {
    console.error(
      `\n⚠️  ${missing.length} app plugin(s) declare a surface but ship no hero asset:\n${missing
        .map((d) => `  - plugins/${d}`)
        .join(
          "\n",
        )}\nAdd a curated entry above or commit plugins/<name>/assets/hero.svg.`,
    );
    return {
      writtenCount: written.length,
      missingCount: missing.length,
      missing,
    };
  }

  return { writtenCount: written.length, missingCount: 0 };
}

export async function runCli(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    printHelp();
    return 0;
  }
  const result = await main(argv);
  return result.missingCount > 0 ? 1 : 0;
}

const invokedDirectly =
  import.meta.main ||
  (Boolean(process.argv[1]) &&
    path.resolve(process.argv[1]) === fileURLToPath(import.meta.url));

if (invokedDirectly) {
  runCli().then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      console.error(
        error instanceof Error
          ? error.message
          : "[generate-view-heroes] failed",
      );
      process.exitCode = 1;
    },
  );
}
