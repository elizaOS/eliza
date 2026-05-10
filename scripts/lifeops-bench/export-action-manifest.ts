#!/usr/bin/env bun
/**
 * export-action-manifest — Snapshot the life-relevant elizaOS Action surface
 * as an OpenAI tool-spec manifest so non-Eliza agents (OpenClaw, Hermes,
 * Cerebras, etc.) can consume the same action catalogue.
 *
 * Usage:
 *   bun run scripts/lifeops-bench/export-action-manifest.ts
 *   bun run scripts/lifeops-bench/export-action-manifest.ts --out <path>
 *   bun run scripts/lifeops-bench/export-action-manifest.ts --include-plugin <name>
 *   bun run scripts/lifeops-bench/export-action-manifest.ts --exclude-plugin <name>
 *   bun run scripts/lifeops-bench/export-action-manifest.ts --tag <tag>
 *
 * Output (default): packages/benchmarks/lifeops-bench/manifests/actions.manifest.json
 * Sibling:          packages/benchmarks/lifeops-bench/manifests/actions.summary.md
 *
 * The manifest reuses the canonical helpers from @elizaos/core
 * (`actionToTool` / `actionToJsonSchema`) so the output is byte-equivalent to
 * what the planner would render for each action — plus a small set of `_`-
 * prefixed metadata fields (plugin, tags, contexts, priority, examples_count)
 * that downstream agents can use for routing or filtering.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { Action, Plugin } from "@elizaos/core";
// `actionToTool` and `actionToJsonSchema` are not re-exported from the
// `@elizaos/core` barrel — import them directly from the source module so we
// stay byte-equivalent with the planner's own rendering.
import { actionToTool } from "../../packages/core/src/actions/to-tool.ts";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

const DEFAULT_OUT_PATH = path.join(
  REPO_ROOT,
  "packages/benchmarks/lifeops-bench/manifests/actions.manifest.json",
);

interface PluginSource {
  /** Logical id used by --include / --exclude flags. */
  id: string;
  /** Human-readable label that lands in `_plugin`. */
  label: string;
  /** Async loader for the plugin module. */
  load: () => Promise<{ plugin: Plugin | null; reason?: string }>;
}

const DEFAULT_INCLUDED: ReadonlySet<string> = new Set([
  "app-lifeops",
  "app-phone",
  "app-contacts",
  "plugin-todos",
  "plugin-imessage",
  "plugin-bluebubbles",
]);

const PLUGIN_SOURCES: PluginSource[] = [
  {
    id: "app-lifeops",
    label: "@elizaos/app-lifeops",
    load: async () => {
      const mod: { appLifeOpsPlugin?: Plugin } = await import(
        "../../plugins/app-lifeops/src/plugin.ts"
      );
      return { plugin: mod.appLifeOpsPlugin ?? null };
    },
  },
  {
    id: "app-phone",
    label: "@elizaos/app-phone",
    load: async () => {
      const mod: { appPhonePlugin?: Plugin } = await import(
        "../../plugins/app-phone/src/plugin.ts"
      );
      return { plugin: mod.appPhonePlugin ?? null };
    },
  },
  {
    id: "app-contacts",
    label: "@elizaos/app-contacts",
    load: async () => {
      const mod: { appContactsPlugin?: Plugin } = await import(
        "../../plugins/app-contacts/src/plugin.ts"
      );
      return { plugin: mod.appContactsPlugin ?? null };
    },
  },
  {
    id: "plugin-todos",
    label: "@elizaos/plugin-todos",
    load: async () => {
      const mod: { todosPlugin?: Plugin; default?: Plugin } = await import(
        "../../plugins/plugin-todos/src/index.ts"
      );
      return { plugin: mod.todosPlugin ?? mod.default ?? null };
    },
  },
  {
    id: "plugin-imessage",
    label: "@elizaos/plugin-imessage",
    load: async () => {
      const mod: { default?: Plugin } = await import(
        "../../plugins/plugin-imessage/src/index.ts"
      );
      return {
        plugin: mod.default ?? null,
        reason:
          mod.default && (mod.default.actions?.length ?? 0) === 0
            ? "plugin exposes no static actions (delivery is handled via MessageConnector send-handlers registered at init time)"
            : undefined,
      };
    },
  },
  {
    id: "plugin-bluebubbles",
    label: "@elizaos/plugin-bluebubbles",
    load: async () => {
      const mod: { default?: Plugin } = await import(
        "../../plugins/plugin-bluebubbles/src/index.ts"
      );
      return {
        plugin: mod.default ?? null,
        reason:
          mod.default && (mod.default.actions?.length ?? 0) === 0
            ? "plugin exposes no static actions (delivery is handled via MessageConnector send-handlers registered at init time)"
            : undefined,
      };
    },
  },
];

interface CliOptions {
  outPath: string;
  include: Set<string>;
  exclude: Set<string>;
  tagFilter: Set<string>;
}

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    outPath: DEFAULT_OUT_PATH,
    include: new Set(),
    exclude: new Set(),
    tagFilter: new Set(),
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--out") {
      const value = argv[++i];
      if (!value) {
        throw new Error("--out requires a path");
      }
      opts.outPath = path.resolve(value);
    } else if (arg === "--include-plugin") {
      const value = argv[++i];
      if (!value) {
        throw new Error("--include-plugin requires a name");
      }
      opts.include.add(value);
    } else if (arg === "--exclude-plugin") {
      const value = argv[++i];
      if (!value) {
        throw new Error("--exclude-plugin requires a name");
      }
      opts.exclude.add(value);
    } else if (arg === "--tag") {
      const value = argv[++i];
      if (!value) {
        throw new Error("--tag requires a tag");
      }
      opts.tagFilter.add(value);
    } else if (arg === "--help" || arg === "-h") {
      printHelpAndExit();
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return opts;
}

function printHelpAndExit(): never {
  process.stdout.write(
    [
      "export-action-manifest — emit an OpenAI tool-spec manifest of life-relevant Actions",
      "",
      "Flags:",
      "  --out <path>             Output JSON path (default: packages/benchmarks/lifeops-bench/manifests/actions.manifest.json)",
      "  --include-plugin <name>  Restrict to specific plugin ids (repeatable). Overrides defaults.",
      "  --exclude-plugin <name>  Drop plugin ids (repeatable). Applied after include filter.",
      "  --tag <tag>              Only emit actions tagged with the given tag (repeatable; OR semantics).",
      "  -h, --help               Show this help and exit.",
      "",
      `Available plugin ids: ${PLUGIN_SOURCES.map((p) => p.id).join(", ")}`,
    ].join("\n") + "\n",
  );
  process.exit(0);
}

interface ManifestEntry {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: {
      type: "object";
      properties: Record<string, unknown>;
      required: string[];
      additionalProperties: false;
    };
    strict?: true;
  };
  _plugin: string;
  _tags: string[];
  _contexts: string[];
  _priority: number;
  _examples_count: number;
}

interface SkippedEntry {
  plugin: string;
  reason: string;
  action?: string;
}

function buildEntry(
  action: Action,
  pluginLabel: string,
  warnings: string[],
): ManifestEntry {
  const tool = actionToTool(action);
  const params = tool.function.parameters as {
    type?: string;
    properties?: Record<string, unknown>;
    required?: string[];
    additionalProperties?: unknown;
  };

  const hasParameters =
    Array.isArray(action.parameters) && action.parameters.length > 0;
  if (!hasParameters) {
    warnings.push(
      `[warn] ${action.name} (${pluginLabel}): no typed parameters; emitting empty {} schema`,
    );
  }

  // Normalize parameters into strict OpenAI shape regardless of upstream shape.
  // `actionToJsonSchema` already returns this exact form, but we re-assert
  // here so the output is statically valid even if upstream changes.
  const properties: Record<string, unknown> =
    typeof params.properties === "object" && params.properties !== null
      ? params.properties
      : {};
  const required: string[] = Array.isArray(params.required)
    ? params.required.filter((entry): entry is string => typeof entry === "string")
    : [];

  const entry: ManifestEntry = {
    type: "function",
    function: {
      name: tool.function.name,
      description: tool.function.description ?? "",
      parameters: {
        type: "object",
        properties,
        required,
        additionalProperties: false,
      },
      strict: true,
    },
    _plugin: pluginLabel,
    _tags: Array.isArray(action.tags) ? [...action.tags] : [],
    _contexts: Array.isArray(action.contexts)
      ? action.contexts.map((c) => String(c))
      : [],
    _priority: typeof action.priority === "number" ? action.priority : 100,
    _examples_count: Array.isArray(action.examples) ? action.examples.length : 0,
  };

  validateStrictShape(entry);
  return entry;
}

function validateStrictShape(entry: ManifestEntry): void {
  const fn = entry.function;
  if (!fn.name || typeof fn.name !== "string") {
    throw new Error(`Manifest entry missing function.name`);
  }
  if (typeof fn.description !== "string") {
    throw new Error(
      `Manifest entry ${fn.name} missing function.description (string)`,
    );
  }
  const p = fn.parameters;
  if (p.type !== "object") {
    throw new Error(`Manifest entry ${fn.name}: parameters.type must be 'object'`);
  }
  if (p.additionalProperties !== false) {
    throw new Error(
      `Manifest entry ${fn.name}: parameters.additionalProperties must be false`,
    );
  }
  if (typeof p.properties !== "object" || p.properties === null) {
    throw new Error(`Manifest entry ${fn.name}: parameters.properties must be object`);
  }
  if (!Array.isArray(p.required)) {
    throw new Error(`Manifest entry ${fn.name}: parameters.required must be array`);
  }
}

function shouldKeepByTag(action: Action, tagFilter: Set<string>): boolean {
  if (tagFilter.size === 0) return true;
  const tags = Array.isArray(action.tags) ? action.tags : [];
  for (const tag of tags) {
    if (tagFilter.has(tag)) return true;
  }
  return false;
}

function clip(text: string, max: number): string {
  const trimmed = text.replace(/\s+/g, " ").trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max - 1)}…`;
}

function escapeMarkdownCell(text: string): string {
  return text.replace(/\|/g, "\\|");
}

function buildSummaryMarkdown(
  entries: ManifestEntry[],
  filter: { include: string[]; exclude: string[]; tags: string[] },
  generatedAt: string,
): string {
  const lines: string[] = [];
  lines.push("# LifeOps Action Manifest — Summary");
  lines.push("");
  lines.push(`Generated: ${generatedAt}`);
  lines.push(
    `Filter: include=[${filter.include.join(", ") || "default"}] exclude=[${filter.exclude.join(", ") || "none"}] tags=[${filter.tags.join(", ") || "any"}]`,
  );
  lines.push(`Total actions: ${entries.length}`);
  lines.push("");

  const byPlugin = new Map<string, number>();
  for (const e of entries) {
    byPlugin.set(e._plugin, (byPlugin.get(e._plugin) ?? 0) + 1);
  }
  lines.push("## Plugin breakdown");
  lines.push("");
  lines.push("| Plugin | Actions |");
  lines.push("| --- | ---: |");
  for (const [plugin, count] of [...byPlugin.entries()].sort()) {
    lines.push(`| ${escapeMarkdownCell(plugin)} | ${count} |`);
  }
  lines.push("");

  lines.push("## Actions");
  lines.push("");
  lines.push("| Action | Plugin | Description | Params | Examples? |");
  lines.push("| --- | --- | --- | ---: | :---: |");
  const sorted = [...entries].sort((a, b) =>
    a.function.name.localeCompare(b.function.name),
  );
  for (const e of sorted) {
    const paramCount = Object.keys(e.function.parameters.properties).length;
    const hasExamples = e._examples_count > 0 ? "yes" : "no";
    lines.push(
      `| \`${e.function.name}\` | ${escapeMarkdownCell(e._plugin)} | ${escapeMarkdownCell(clip(e.function.description, 80))} | ${paramCount} | ${hasExamples} |`,
    );
  }
  lines.push("");
  return lines.join("\n");
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));

  const includeSet = opts.include.size > 0 ? opts.include : DEFAULT_INCLUDED;
  const selectedSources = PLUGIN_SOURCES.filter(
    (src) => includeSet.has(src.id) && !opts.exclude.has(src.id),
  );

  const warnings: string[] = [];
  const skipped: SkippedEntry[] = [];
  const entries: ManifestEntry[] = [];
  const seenNames = new Set<string>();

  for (const source of selectedSources) {
    let plugin: Plugin | null = null;
    let reason: string | undefined;
    try {
      const loaded = await source.load();
      plugin = loaded.plugin;
      reason = loaded.reason;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      skipped.push({
        plugin: source.label,
        reason: `failed to import: ${message}`,
      });
      continue;
    }

    if (!plugin) {
      skipped.push({
        plugin: source.label,
        reason: "plugin module did not export a Plugin object",
      });
      continue;
    }

    const actions = Array.isArray(plugin.actions) ? plugin.actions : [];
    if (actions.length === 0) {
      skipped.push({
        plugin: source.label,
        reason:
          reason ?? "plugin.actions is empty; nothing to export statically",
      });
      continue;
    }

    for (const action of actions) {
      if (!action || typeof action.name !== "string") continue;
      if (!shouldKeepByTag(action, opts.tagFilter)) continue;
      if (seenNames.has(action.name)) {
        warnings.push(
          `[warn] duplicate action name '${action.name}' from ${source.label}; keeping first occurrence`,
        );
        continue;
      }

      try {
        const entry = buildEntry(action, source.label, warnings);
        entries.push(entry);
        seenNames.add(action.name);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        skipped.push({
          plugin: source.label,
          action: action.name,
          reason: `failed to build manifest entry: ${message}`,
        });
      }
    }
  }

  entries.sort((a, b) => a.function.name.localeCompare(b.function.name));

  const generatedAt = new Date().toISOString();
  const manifest = {
    version: "1.0",
    generated_at: generatedAt,
    filter: {
      include: [...includeSet].sort(),
      exclude: [...opts.exclude].sort(),
      tags: [...opts.tagFilter].sort(),
    },
    actions: entries,
  };

  // Validate by parsing back what we're about to write.
  const serialized = JSON.stringify(manifest, null, 2);
  JSON.parse(serialized);

  fs.mkdirSync(path.dirname(opts.outPath), { recursive: true });
  fs.writeFileSync(opts.outPath, `${serialized}\n`, "utf-8");

  const summaryPath = path.join(
    path.dirname(opts.outPath),
    `${path.basename(opts.outPath, ".json")}.summary.md`.replace(
      /\.manifest\.summary\.md$/,
      ".summary.md",
    ),
  );
  const summary = buildSummaryMarkdown(
    entries,
    {
      include: [...includeSet].sort(),
      exclude: [...opts.exclude].sort(),
      tags: [...opts.tagFilter].sort(),
    },
    generatedAt,
  );
  fs.writeFileSync(summaryPath, summary, "utf-8");

  const stderr = (line: string) => process.stderr.write(`${line}\n`);
  for (const w of warnings) stderr(w);
  for (const s of skipped) {
    stderr(
      `[skip] ${s.plugin}${s.action ? ` :: ${s.action}` : ""} — ${s.reason}`,
    );
  }

  const byPlugin = new Map<string, number>();
  for (const e of entries) {
    byPlugin.set(e._plugin, (byPlugin.get(e._plugin) ?? 0) + 1);
  }

  process.stdout.write(
    JSON.stringify(
      {
        ok: true,
        outPath: opts.outPath,
        summaryPath,
        actionCount: entries.length,
        byPlugin: Object.fromEntries(byPlugin),
        warnings: warnings.length,
        skipped: skipped.length,
      },
      null,
      2,
    ) + "\n",
  );
}

main().catch((err) => {
  const message = err instanceof Error ? err.stack ?? err.message : String(err);
  process.stderr.write(`export-action-manifest failed: ${message}\n`);
  process.exit(1);
});
