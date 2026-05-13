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
 *   bun run scripts/lifeops-bench/export-action-manifest.ts --domain <domain>
 *   bun run scripts/lifeops-bench/export-action-manifest.ts --capability <capability>
 *   bun run scripts/lifeops-bench/export-action-manifest.ts --surface <surface>
 *   bun run scripts/lifeops-bench/export-action-manifest.ts --exclude-risk <risk>
 *   bun run scripts/lifeops-bench/export-action-manifest.ts --validate-taxonomy
 *
 * Output (default): packages/benchmarks/lifeops-bench/manifests/actions.manifest.json
 * Sibling:          packages/benchmarks/lifeops-bench/manifests/actions.summary.md
 *
 * The manifest reuses the canonical helpers from @elizaos/core
 * (`actionToTool` / `actionToJsonSchema`) so the output is byte-equivalent to
 * what the planner would render for each action — plus a small set of `_`-
 * prefixed metadata fields (plugin, tags, contexts, priority, examples_count)
 * that downstream agents can use for routing or filtering.
 *
 * The taxonomy enforced by `--validate-taxonomy` is canonical at
 * `docs/audits/lifeops-2026-05-09/14-capability-taxonomy.md`.
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

// ---------------------------------------------------------------------------
// Canonical taxonomy — see docs/audits/lifeops-2026-05-09/14-capability-taxonomy.md
// ---------------------------------------------------------------------------

const DOMAIN_TAGS: ReadonlySet<string> = new Set([
  "domain:calendar",
  "domain:mail",
  "domain:messages",
  "domain:contacts",
  "domain:reminders",
  "domain:notes",
  "domain:finance",
  "domain:travel",
  "domain:health",
  "domain:sleep",
  "domain:focus",
  "domain:home",
  "domain:music",
  "domain:entity",
  "domain:meta",
]);

const CAPABILITY_TAGS: ReadonlySet<string> = new Set([
  "capability:read",
  "capability:write",
  "capability:update",
  "capability:delete",
  "capability:send",
  "capability:schedule",
  "capability:execute",
]);

const SURFACE_TAGS: ReadonlySet<string> = new Set([
  "surface:remote-api",
  "surface:device",
  "surface:internal",
  "surface:eliza-cloud",
]);

const RISK_TAGS: ReadonlySet<string> = new Set([
  "risk:irreversible",
  "risk:financial",
  "risk:user-visible",
]);

const COST_TAGS: ReadonlySet<string> = new Set([
  "cost:cheap",
  "cost:expensive",
]);

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
  domainFilter: Set<string>;
  capabilityFilter: Set<string>;
  surfaceFilter: Set<string>;
  excludeRisks: Set<string>;
  validateTaxonomy: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    outPath: DEFAULT_OUT_PATH,
    include: new Set(),
    exclude: new Set(),
    tagFilter: new Set(),
    domainFilter: new Set(),
    capabilityFilter: new Set(),
    surfaceFilter: new Set(),
    excludeRisks: new Set(),
    validateTaxonomy: false,
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
    } else if (arg === "--domain") {
      const value = argv[++i];
      if (!value) throw new Error("--domain requires a value");
      opts.domainFilter.add(`domain:${stripPrefix(value, "domain:")}`);
    } else if (arg === "--capability") {
      const value = argv[++i];
      if (!value) throw new Error("--capability requires a value");
      opts.capabilityFilter.add(
        `capability:${stripPrefix(value, "capability:")}`,
      );
    } else if (arg === "--surface") {
      const value = argv[++i];
      if (!value) throw new Error("--surface requires a value");
      opts.surfaceFilter.add(`surface:${stripPrefix(value, "surface:")}`);
    } else if (arg === "--exclude-risk") {
      const value = argv[++i];
      if (!value) throw new Error("--exclude-risk requires a value");
      opts.excludeRisks.add(`risk:${stripPrefix(value, "risk:")}`);
    } else if (arg === "--validate-taxonomy") {
      opts.validateTaxonomy = true;
    } else if (arg === "--help" || arg === "-h") {
      printHelpAndExit();
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return opts;
}

function stripPrefix(value: string, prefix: string): string {
  return value.startsWith(prefix) ? value.slice(prefix.length) : value;
}

function printHelpAndExit(): never {
  process.stdout.write(
    `${[
      "export-action-manifest — emit an OpenAI tool-spec manifest of life-relevant Actions",
      "",
      "Flags:",
      "  --out <path>             Output JSON path (default: packages/benchmarks/lifeops-bench/manifests/actions.manifest.json)",
      "  --include-plugin <name>  Restrict to specific plugin ids (repeatable). Overrides defaults.",
      "  --exclude-plugin <name>  Drop plugin ids (repeatable). Applied after include filter.",
      "  --tag <tag>              Only emit actions tagged with the given tag (repeatable; OR semantics).",
      "  --domain <domain>        Filter to actions tagged `domain:<domain>` (repeatable; OR within category).",
      "  --capability <cap>       Filter to actions tagged `capability:<cap>` (repeatable; OR within category).",
      "  --surface <surface>      Filter to actions tagged `surface:<surface>` (repeatable; OR within category).",
      "  --exclude-risk <risk>    Drop actions tagged `risk:<risk>` (repeatable). Useful for sandboxed harnesses.",
      "  --validate-taxonomy      Print taxonomy violations and exit non-zero if any are found.",
      "  -h, --help               Show this help and exit.",
      "",
      "Filter semantics: AND across categories (domain ∧ capability ∧ surface), OR within a category.",
      "",
      `Available plugin ids: ${PLUGIN_SOURCES.map((p) => p.id).join(", ")}`,
    ].join("\n")}\n`,
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
  _domain: string | null;
  _capabilities: string[];
  _surfaces: string[];
  _risk: string | null;
  _cost: string | null;
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

  const properties: Record<string, unknown> =
    typeof params.properties === "object" && params.properties !== null
      ? params.properties
      : {};
  const required: string[] = Array.isArray(params.required)
    ? params.required.filter(
        (entry): entry is string => typeof entry === "string",
      )
    : [];

  const tags = Array.isArray(action.tags) ? [...action.tags] : [];
  const projection = projectTaxonomy(tags);

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
    _tags: tags,
    _contexts: Array.isArray(action.contexts)
      ? action.contexts.map((c) => String(c))
      : [],
    _priority: typeof action.priority === "number" ? action.priority : 100,
    _examples_count: Array.isArray(action.examples)
      ? action.examples.length
      : 0,
    _domain: projection.domain,
    _capabilities: projection.capabilities,
    _surfaces: projection.surfaces,
    _risk: projection.risk,
    _cost: projection.cost,
  };

  validateStrictShape(entry);
  return entry;
}

interface TaxonomyProjection {
  domain: string | null;
  capabilities: string[];
  surfaces: string[];
  risk: string | null;
  cost: string | null;
}

function projectTaxonomy(tags: readonly string[]): TaxonomyProjection {
  const domains = tags.filter((t) => DOMAIN_TAGS.has(t));
  const capabilities = tags.filter((t) => CAPABILITY_TAGS.has(t));
  const surfaces = tags.filter((t) => SURFACE_TAGS.has(t));
  const risks = tags.filter((t) => RISK_TAGS.has(t));
  const costs = tags.filter((t) => COST_TAGS.has(t));
  return {
    domain: domains[0] ?? null,
    capabilities,
    surfaces,
    risk: risks[0] ?? null,
    cost: costs[0] ?? null,
  };
}

interface TaxonomyViolation {
  action: string;
  plugin: string;
  message: string;
}

function findTaxonomyViolations(
  entries: readonly ManifestEntry[],
): TaxonomyViolation[] {
  const violations: TaxonomyViolation[] = [];
  for (const entry of entries) {
    const tags = entry._tags;
    const projection = projectTaxonomy(tags);

    // Catch any tag that isn't in any known taxonomy bucket.
    const unknownTags = tags.filter(
      (t) =>
        !DOMAIN_TAGS.has(t) &&
        !CAPABILITY_TAGS.has(t) &&
        !SURFACE_TAGS.has(t) &&
        !RISK_TAGS.has(t) &&
        !COST_TAGS.has(t),
    );
    for (const tag of unknownTags) {
      violations.push({
        action: entry.function.name,
        plugin: entry._plugin,
        message: `non-canonical tag '${tag}' (must be a domain/capability/surface/risk/cost tag)`,
      });
    }

    const domains = tags.filter((t) => DOMAIN_TAGS.has(t));
    if (domains.length === 0) {
      violations.push({
        action: entry.function.name,
        plugin: entry._plugin,
        message: "missing required domain tag (e.g. 'domain:calendar')",
      });
    } else if (domains.length > 1) {
      violations.push({
        action: entry.function.name,
        plugin: entry._plugin,
        message: `must have exactly one domain tag, found ${domains.length}: ${domains.join(", ")}`,
      });
    }

    if (projection.capabilities.length === 0) {
      violations.push({
        action: entry.function.name,
        plugin: entry._plugin,
        message:
          "missing required capability tag (at least one capability:* required)",
      });
    }

    if (projection.surfaces.length === 0) {
      violations.push({
        action: entry.function.name,
        plugin: entry._plugin,
        message:
          "missing required surface tag (at least one surface:* required)",
      });
    }

    const risks = tags.filter((t) => RISK_TAGS.has(t));
    if (risks.length > 1) {
      violations.push({
        action: entry.function.name,
        plugin: entry._plugin,
        message: `at most one risk tag allowed, found ${risks.length}: ${risks.join(", ")}`,
      });
    }

    const costs = tags.filter((t) => COST_TAGS.has(t));
    if (costs.length > 1) {
      violations.push({
        action: entry.function.name,
        plugin: entry._plugin,
        message: `at most one cost tag allowed, found ${costs.length}: ${costs.join(", ")}`,
      });
    }
  }
  return violations;
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
    throw new Error(
      `Manifest entry ${fn.name}: parameters.type must be 'object'`,
    );
  }
  if (p.additionalProperties !== false) {
    throw new Error(
      `Manifest entry ${fn.name}: parameters.additionalProperties must be false`,
    );
  }
  if (typeof p.properties !== "object" || p.properties === null) {
    throw new Error(
      `Manifest entry ${fn.name}: parameters.properties must be object`,
    );
  }
  if (!Array.isArray(p.required)) {
    throw new Error(
      `Manifest entry ${fn.name}: parameters.required must be array`,
    );
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

function shouldKeepByCategory(
  tags: readonly string[],
  filter: Set<string>,
): boolean {
  if (filter.size === 0) return true;
  for (const tag of tags) {
    if (filter.has(tag)) return true;
  }
  return false;
}

function shouldDropByExcludedRisk(
  tags: readonly string[],
  excludedRisks: Set<string>,
): boolean {
  if (excludedRisks.size === 0) return false;
  for (const tag of tags) {
    if (excludedRisks.has(tag)) return true;
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
  filter: {
    include: string[];
    exclude: string[];
    tags: string[];
    domains: string[];
    capabilities: string[];
    surfaces: string[];
    excludeRisks: string[];
  },
  generatedAt: string,
): string {
  const lines: string[] = [];
  lines.push("# LifeOps Action Manifest — Summary");
  lines.push("");
  lines.push(`Generated: ${generatedAt}`);
  lines.push(
    `Filter: include=[${filter.include.join(", ") || "default"}] exclude=[${filter.exclude.join(", ") || "none"}] tags=[${filter.tags.join(", ") || "any"}] domains=[${filter.domains.join(", ") || "any"}] capabilities=[${filter.capabilities.join(", ") || "any"}] surfaces=[${filter.surfaces.join(", ") || "any"}] excludeRisks=[${filter.excludeRisks.join(", ") || "none"}]`,
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

  // Domain breakdown.
  const byDomain = new Map<string, ManifestEntry[]>();
  for (const e of entries) {
    const key = e._domain ?? "(untagged)";
    const bucket = byDomain.get(key) ?? [];
    bucket.push(e);
    byDomain.set(key, bucket);
  }
  lines.push("## Domain breakdown");
  lines.push("");
  lines.push("| Domain | Actions |");
  lines.push("| --- | ---: |");
  for (const [domain, bucket] of [...byDomain.entries()].sort()) {
    lines.push(`| ${escapeMarkdownCell(domain)} | ${bucket.length} |`);
  }
  lines.push("");

  // Risk breakdown.
  const byRisk = new Map<string, number>();
  for (const e of entries) {
    const key = e._risk ?? "(no risk)";
    byRisk.set(key, (byRisk.get(key) ?? 0) + 1);
  }
  lines.push("## Risk breakdown");
  lines.push("");
  lines.push("| Risk | Actions |");
  lines.push("| --- | ---: |");
  for (const [risk, count] of [...byRisk.entries()].sort()) {
    lines.push(`| ${escapeMarkdownCell(risk)} | ${count} |`);
  }
  lines.push("");

  lines.push("## Actions by domain");
  lines.push("");
  for (const [domain, bucket] of [...byDomain.entries()].sort()) {
    lines.push(`### ${domain}`);
    lines.push("");
    lines.push(
      "| Action | Plugin | Risk | Capabilities | Surfaces | Description |",
    );
    lines.push("| --- | --- | :---: | --- | --- | --- |");
    const sorted = [...bucket].sort((a, b) =>
      a.function.name.localeCompare(b.function.name),
    );
    for (const e of sorted) {
      const risk = e._risk ?? "—";
      const caps = e._capabilities
        .map((c) => c.replace("capability:", ""))
        .join(", ");
      const surfs = e._surfaces
        .map((s) => s.replace("surface:", ""))
        .join(", ");
      lines.push(
        `| \`${e.function.name}\` | ${escapeMarkdownCell(e._plugin)} | ${escapeMarkdownCell(risk)} | ${escapeMarkdownCell(caps)} | ${escapeMarkdownCell(surfs)} | ${escapeMarkdownCell(clip(e.function.description, 80))} |`,
      );
    }
    lines.push("");
  }
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
      const actionTags = Array.isArray(action.tags) ? action.tags : [];
      if (!shouldKeepByCategory(actionTags, opts.domainFilter)) continue;
      if (!shouldKeepByCategory(actionTags, opts.capabilityFilter)) continue;
      if (!shouldKeepByCategory(actionTags, opts.surfaceFilter)) continue;
      if (shouldDropByExcludedRisk(actionTags, opts.excludeRisks)) continue;
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

  // Taxonomy validation gate. When --validate-taxonomy is set we print every
  // violation and exit non-zero so CI fails on regression. Otherwise we still
  // print violations as warnings but proceed with the export.
  const taxonomyViolations = findTaxonomyViolations(entries);
  if (opts.validateTaxonomy) {
    const stderr = (line: string) => process.stderr.write(`${line}\n`);
    if (taxonomyViolations.length === 0) {
      process.stdout.write(
        `${JSON.stringify(
          {
            ok: true,
            mode: "validate-taxonomy",
            actionCount: entries.length,
            violations: 0,
          },
          null,
          2,
        )}\n`,
      );
      process.exit(0);
    }
    for (const v of taxonomyViolations) {
      stderr(`[taxonomy] ${v.action} (${v.plugin}): ${v.message}`);
    }
    process.stdout.write(
      `${JSON.stringify(
        {
          ok: false,
          mode: "validate-taxonomy",
          actionCount: entries.length,
          violations: taxonomyViolations.length,
        },
        null,
        2,
      )}\n`,
    );
    process.exit(1);
  }

  const generatedAt = new Date().toISOString();
  const manifest = {
    version: "1.0",
    generated_at: generatedAt,
    filter: {
      include: [...includeSet].sort(),
      exclude: [...opts.exclude].sort(),
      tags: [...opts.tagFilter].sort(),
      domains: [...opts.domainFilter].sort(),
      capabilities: [...opts.capabilityFilter].sort(),
      surfaces: [...opts.surfaceFilter].sort(),
      excludeRisks: [...opts.excludeRisks].sort(),
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
      domains: [...opts.domainFilter].sort(),
      capabilities: [...opts.capabilityFilter].sort(),
      surfaces: [...opts.surfaceFilter].sort(),
      excludeRisks: [...opts.excludeRisks].sort(),
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
  for (const v of taxonomyViolations) {
    stderr(`[taxonomy] ${v.action} (${v.plugin}): ${v.message}`);
  }

  const byPlugin = new Map<string, number>();
  for (const e of entries) {
    byPlugin.set(e._plugin, (byPlugin.get(e._plugin) ?? 0) + 1);
  }

  const byDomain = new Map<string, number>();
  for (const e of entries) {
    const key = e._domain ?? "(untagged)";
    byDomain.set(key, (byDomain.get(key) ?? 0) + 1);
  }

  process.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        outPath: opts.outPath,
        summaryPath,
        actionCount: entries.length,
        byPlugin: Object.fromEntries(byPlugin),
        byDomain: Object.fromEntries(byDomain),
        warnings: warnings.length,
        skipped: skipped.length,
        taxonomyViolations: taxonomyViolations.length,
      },
      null,
      2,
    )}\n`,
  );
}

main().catch((err) => {
  const message =
    err instanceof Error ? (err.stack ?? err.message) : String(err);
  process.stderr.write(`export-action-manifest failed: ${message}\n`);
  process.exit(1);
});
