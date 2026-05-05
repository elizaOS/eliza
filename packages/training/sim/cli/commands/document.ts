/**
 * `babylon document` -- Generate markdown reference pages from system metadata.
 *
 * Scans the systems directory, loads each system, and writes a markdown file
 * for each one plus an index page for the sim itself. These are auto-generated
 * from the runtime metadata (id, name, phase, dependencies, intervals, etc.),
 * not from the hand-written docs in docs/.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { basename, relative, resolve } from "node:path";
import { defineCommand } from "citty";
import consola from "consola";
import { loadBabylonConfig } from "../../core/config";
import { scanSystems } from "../../core/scanner";
import type { BabylonSystem } from "../../core/types";
import { escapeMarkdown, phaseName } from "../shared";

function formatInterval(interval: {
  every?: number;
  everyMs?: number;
}): string {
  const parts: string[] = [];
  if (interval.every !== undefined) {
    parts.push(
      `Every ${interval.every} tick${interval.every === 1 ? "" : "s"}`,
    );
  }
  if (interval.everyMs !== undefined) {
    if (interval.everyMs < 1000) {
      parts.push(`Every ${interval.everyMs}ms`);
    } else {
      const seconds = interval.everyMs / 1000;
      if (seconds >= 60) {
        parts.push(
          `Every ${Math.round(seconds / 60)} minute${Math.round(seconds / 60) === 1 ? "" : "s"}`,
        );
      } else {
        parts.push(`Every ${seconds} second${seconds === 1 ? "" : "s"}`);
      }
    }
  }
  return parts.join(", ") || "Unknown";
}

function generateSystemPage(
  sys: BabylonSystem,
  sourceFile: string | null,
): string {
  const lines: string[] = [];

  lines.push(`# ${escapeMarkdown(sys.name)}`);
  lines.push("");
  lines.push(`**ID:** \`${sys.id}\``);
  lines.push(`**Phase:** ${phaseName(sys.phase)} (${sys.phase})`);

  if (sys.skipDeadlineCheck) {
    lines.push("**Deadline:** Always runs (skipDeadlineCheck)");
  }

  if (sourceFile) {
    lines.push(`**Source:** \`${sourceFile}\``);
  }

  lines.push("");

  if (sys.dependencies && sys.dependencies.length > 0) {
    lines.push("## Dependencies");
    lines.push("");
    lines.push(
      `Runs after: ${sys.dependencies.map((d) => `\`${d}\``).join(", ")}`,
    );
    lines.push("");
  }

  if (sys.intervals && Object.keys(sys.intervals).length > 0) {
    lines.push("## Intervals");
    lines.push("");
    lines.push("| Name | Trigger |");
    lines.push("|---|---|");
    for (const [name, interval] of Object.entries(sys.intervals)) {
      lines.push(`| ${escapeMarkdown(name)} | ${formatInterval(interval)} |`);
    }
    lines.push("");
  }

  const capabilities: string[] = [];
  if (typeof sys.register === "function")
    capabilities.push("Registers services at boot");
  if (typeof sys.destroy === "function")
    capabilities.push("Runs cleanup at shutdown");
  if (sys.intervals && Object.keys(sys.intervals).length > 0) {
    capabilities.push(
      `Has ${Object.keys(sys.intervals).length} interval handler(s)`,
    );
  }

  if (capabilities.length > 0) {
    lines.push("## Lifecycle");
    lines.push("");
    for (const cap of capabilities) {
      lines.push(`- ${cap}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

function generateIndexPage(
  systems: BabylonSystem[],
  config: { budgetMs?: number; systemsDir?: string },
): string {
  const lines: string[] = [];

  lines.push("# Babylon Sim");
  lines.push("");
  lines.push("Auto-generated reference from runtime metadata.");
  lines.push("");

  lines.push("## Configuration");
  lines.push("");
  lines.push(`- **Tick budget:** ${config.budgetMs ?? 60_000}ms`);
  lines.push(`- **Systems directory:** ${config.systemsDir ?? "./systems"}`);
  lines.push(`- **Total systems:** ${systems.length}`);
  lines.push("");

  // Group by phase
  const byPhase = new Map<number, BabylonSystem[]>();
  for (const sys of systems) {
    const group = byPhase.get(sys.phase) ?? [];
    group.push(sys);
    byPhase.set(sys.phase, group);
  }

  const phases = [...byPhase.keys()].sort((a, b) => a - b);

  lines.push("## Systems by phase");
  lines.push("");

  for (const phase of phases) {
    const group = byPhase.get(phase);
    if (!group) continue;
    lines.push(`### ${phaseName(phase)} (${phase})`);
    lines.push("");
    lines.push("| System | ID | Flags |");
    lines.push("|---|---|---|");
    for (const sys of group) {
      const flags: string[] = [];
      if (sys.skipDeadlineCheck) flags.push("critical");
      if (sys.dependencies?.length)
        flags.push(`deps: ${sys.dependencies.join(", ")}`);
      if (sys.intervals && Object.keys(sys.intervals).length > 0) {
        flags.push(`${Object.keys(sys.intervals).length} interval(s)`);
      }
      const link = `[${escapeMarkdown(sys.name)}](./${sys.id}.md)`;
      lines.push(`| ${link} | \`${sys.id}\` | ${flags.join(", ") || "-"} |`);
    }
    lines.push("");
  }

  if (systems.length === 0) {
    lines.push("No systems discovered.");
    lines.push("");
  }

  return lines.join("\n");
}

function findSourceFile(files: string[], systemId: string): string | undefined {
  // Exact basename match first (e.g. "markets.ts" for id "markets")
  const exactMatch = files.find((f) => {
    const base = basename(f).replace(/\.(ts|js|mts|mjs)$/, "");
    return base === systemId || base === systemId.replace(/-/g, "_");
  });
  if (exactMatch) return exactMatch;
  // Fall back to includes
  return files.find((f) => {
    const base = basename(f).toLowerCase();
    return (
      base.includes(systemId) || base.includes(systemId.replace(/-/g, "_"))
    );
  });
}

export default defineCommand({
  meta: {
    name: "document",
    description: "Generate markdown reference pages from system metadata",
  },
  args: {
    rootDir: {
      type: "string",
      description: "Project root directory",
      default: ".",
    },
    outDir: {
      type: "string",
      description: "Output directory for generated docs",
      default: ".docs",
    },
  },
  async run({ args }) {
    const rootDir = resolve(args.rootDir);
    const outDir = resolve(rootDir, args.outDir);

    const { config, configFile } = await loadBabylonConfig(rootDir);
    consola.info(`Config: ${configFile ?? "defaults"}`);

    const { systems, files } = await scanSystems(
      config.systemsDir ?? "./systems",
      rootDir,
    );
    consola.info(`Discovered ${systems.length} system(s)`);

    await mkdir(outDir, { recursive: true });

    // Generate index page
    const indexContent = generateIndexPage(systems, config);
    const indexPath = resolve(outDir, "index.md");
    await writeFile(indexPath, indexContent, "utf-8");

    // Generate a page per system
    for (const sys of systems) {
      const sourceFile = findSourceFile(files, sys.id);
      const relSource = sourceFile ? relative(rootDir, sourceFile) : null;
      const content = generateSystemPage(sys, relSource);
      const filePath = resolve(outDir, `${sys.id}.md`);
      await writeFile(filePath, content, "utf-8");
    }

    const total = systems.length + 1;
    consola.success(
      `Generated ${total} page(s) in ${relative(rootDir, outDir)}/`,
    );
  },
});
