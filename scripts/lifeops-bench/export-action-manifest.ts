#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildPlannerToolsFromActions } from "../../packages/core/src/actions/to-tool.ts";
import type { Action } from "../../packages/core/src/types/components.ts";
import type { Plugin } from "../../packages/core/src/types/plugin.ts";
import blueBubblesPlugin from "../../plugins/plugin-bluebubbles/src/index.ts";
import { appContactsPlugin } from "../../plugins/plugin-contacts/src/plugin.ts";
import imessagePlugin from "../../plugins/plugin-imessage/src/index.ts";
import { personalAssistantPlugin } from "../../plugins/plugin-personal-assistant/src/plugin.ts";
import { appPhonePlugin } from "../../plugins/plugin-phone/src/plugin.ts";
import { todosPlugin } from "../../plugins/plugin-todos/src/index.ts";

type JsonObject = Record<string, unknown>;

type ManifestEntry = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: JsonObject;
    strict: true;
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
};

type Manifest = {
  schemaVersion: 1;
  generator: string;
  sourcePlugins: string[];
  filters: {
    domains: string[];
    capabilities: string[];
    surfaces: string[];
    excludeRisks: string[];
    benchUmbrellaAugment: boolean;
  };
  actions: ManifestEntry[];
};

type CliOptions = {
  out: string;
  summaryOut: string | null;
  domains: string[];
  capabilities: string[];
  surfaces: string[];
  excludeRisks: string[];
  benchUmbrellaAugment: boolean;
};

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(scriptPath), "../..");
const defaultManifestPath = resolve(
  repoRoot,
  "packages/benchmarks/lifeops-bench/manifests/actions.manifest.json",
);
const defaultSummaryPath = resolve(
  repoRoot,
  "packages/benchmarks/lifeops-bench/manifests/actions.summary.md",
);
const benchmarkPackageRoot = resolve(
  repoRoot,
  "packages/benchmarks/lifeops-bench",
);

function usage(): string {
  return [
    "Usage: node --conditions=eliza-source --conditions=development --import tsx scripts/lifeops-bench/export-action-manifest.ts [options]",
    "",
    "Options:",
    "  --out <path>             Output manifest JSON path.",
    "  --summary-out <path>     Output summary Markdown path. Use 'none' to skip.",
    "  --domain <name>          Keep actions with domain:<name>. Repeatable.",
    "  --capability <name>      Keep actions with capability:<name>. Repeatable.",
    "  --surface <name>         Keep actions with surface:<name>. Repeatable.",
    "  --exclude-risk <name>    Drop actions with risk:<name>. Repeatable.",
    "  --skip-bench-augment     Do not add LifeOpsBench-only umbrella verbs.",
    "  --help                   Print this help.",
  ].join("\n");
}

function readValue(args: string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    out: defaultManifestPath,
    summaryOut: defaultSummaryPath,
    domains: [],
    capabilities: [],
    surfaces: [],
    excludeRisks: [],
    benchUmbrellaAugment: true,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--help":
      case "-h":
        console.log(usage());
        process.exit(0);
        break;
      case "--out":
        options.out = resolve(process.cwd(), readValue(argv, index, arg));
        index += 1;
        break;
      case "--summary-out": {
        const value = readValue(argv, index, arg);
        options.summaryOut =
          value === "none" ? null : resolve(process.cwd(), value);
        index += 1;
        break;
      }
      case "--domain":
        options.domains.push(
          normalizeTaggedValue("domain", readValue(argv, index, arg)),
        );
        index += 1;
        break;
      case "--capability":
        options.capabilities.push(
          normalizeTaggedValue("capability", readValue(argv, index, arg)),
        );
        index += 1;
        break;
      case "--surface":
        options.surfaces.push(
          normalizeTaggedValue("surface", readValue(argv, index, arg)),
        );
        index += 1;
        break;
      case "--exclude-risk":
        options.excludeRisks.push(
          normalizeTaggedValue("risk", readValue(argv, index, arg)),
        );
        index += 1;
        break;
      case "--skip-bench-augment":
        options.benchUmbrellaAugment = false;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}\n\n${usage()}`);
    }
  }

  return options;
}

function normalizeTaggedValue(prefix: string, value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`Empty ${prefix} filter`);
  }
  return trimmed.includes(":") ? trimmed : `${prefix}:${trimmed}`;
}

function partitionTags(
  tags: string[],
): Pick<
  ManifestEntry,
  "_domain" | "_capabilities" | "_surfaces" | "_risk" | "_cost"
> {
  return {
    _domain: tags.find((tag) => tag.startsWith("domain:")) ?? null,
    _capabilities: tags.filter((tag) => tag.startsWith("capability:")),
    _surfaces: tags.filter((tag) => tag.startsWith("surface:")),
    _risk: tags.find((tag) => tag.startsWith("risk:")) ?? null,
    _cost: tags.find((tag) => tag.startsWith("cost:")) ?? null,
  };
}

function examplesCount(action: Action): number {
  return Array.isArray(action.examples) ? action.examples.length : 0;
}

function actionToEntry(action: Action, pluginName: string): ManifestEntry {
  const tool = buildPlannerToolsFromActions([action])[0];
  if (!tool) {
    throw new Error(`Failed to render planner tool for ${action.name}`);
  }
  const tags = [...(action.tags ?? [])];
  const taxonomy = partitionTags(tags);
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters as JsonObject,
      strict: true,
    },
    _plugin: pluginName,
    _tags: tags,
    _contexts: [...(action.contexts ?? ["general"])],
    _priority: action.priority ?? 100,
    _examples_count: examplesCount(action),
    ...taxonomy,
  };
}

function collectEntries(plugins: Plugin[]): ManifestEntry[] {
  const entries: ManifestEntry[] = [];
  const seen = new Set<string>();
  for (const plugin of plugins) {
    for (const action of plugin.actions ?? []) {
      const entry = actionToEntry(action, plugin.name);
      const name = entry.function.name;
      if (seen.has(name)) {
        throw new Error(`Duplicate action name in exported registry: ${name}`);
      }
      seen.add(name);
      entries.push(entry);
    }
  }
  entries.sort((left, right) =>
    left.function.name.localeCompare(right.function.name),
  );
  return entries;
}

function matchesAnyFilter(value: string | null, filters: string[]): boolean {
  return filters.length === 0 || (value !== null && filters.includes(value));
}

function includesAllFilters(values: string[], filters: string[]): boolean {
  return (
    filters.length === 0 || filters.every((filter) => values.includes(filter))
  );
}

function filterEntries(
  entries: ManifestEntry[],
  options: CliOptions,
): ManifestEntry[] {
  return entries.filter((entry) => {
    if (!matchesAnyFilter(entry._domain, options.domains)) {
      return false;
    }
    if (!includesAllFilters(entry._capabilities, options.capabilities)) {
      return false;
    }
    if (!includesAllFilters(entry._surfaces, options.surfaces)) {
      return false;
    }
    if (entry._risk !== null && options.excludeRisks.includes(entry._risk)) {
      return false;
    }
    return true;
  });
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function augmentWithBenchUmbrellas(path: string): void {
  const result = spawnSync(
    "python3",
    ["-m", "eliza_lifeops_bench.manifest_export", path],
    {
      cwd: benchmarkPackageRoot,
      encoding: "utf8",
      stdio: "pipe",
    },
  );
  if (result.status !== 0) {
    throw new Error(
      [
        "LifeOpsBench umbrella manifest augment failed.",
        result.stdout.trim(),
        result.stderr.trim(),
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }
  if (result.stdout.trim()) {
    console.log(result.stdout.trim());
  }
}

function renderList(values: string[]): string {
  return values.length === 0 ? "none" : values.join(", ");
}

function renderSummary(manifest: Manifest): string {
  const actions = [...manifest.actions].sort((left, right) => {
    const leftDomain = left._domain ?? "(untagged)";
    const rightDomain = right._domain ?? "(untagged)";
    return (
      leftDomain.localeCompare(rightDomain) ||
      left.function.name.localeCompare(right.function.name)
    );
  });

  const byPlugin = countBy(actions, (entry) => entry._plugin);
  const byDomain = countBy(actions, (entry) => entry._domain ?? "(untagged)");
  const byRisk = countBy(actions, (entry) => entry._risk ?? "(no risk)");
  const domains = [...byDomain.keys()].sort();

  const lines: string[] = [
    "# LifeOps Action Manifest - Summary",
    "",
    "Generated by `scripts/lifeops-bench/export-action-manifest.ts`.",
    `Filter: domains=[${renderList(manifest.filters.domains)}] capabilities=[${renderList(
      manifest.filters.capabilities,
    )}] surfaces=[${renderList(manifest.filters.surfaces)}] excludeRisks=[${renderList(
      manifest.filters.excludeRisks,
    )}] benchUmbrellaAugment=${manifest.filters.benchUmbrellaAugment}`,
    `Total actions: ${actions.length}`,
    "",
    "## Plugin breakdown",
    "",
    "| Plugin | Actions |",
    "| --- | ---: |",
    ...renderCountRows(byPlugin),
    "",
    "## Domain breakdown",
    "",
    "| Domain | Actions |",
    "| --- | ---: |",
    ...renderCountRows(byDomain),
    "",
    "## Risk breakdown",
    "",
    "| Risk | Actions |",
    "| --- | ---: |",
    ...renderCountRows(byRisk),
    "",
    "## Actions by domain",
    "",
  ];

  for (const domain of domains) {
    lines.push(`### ${domain}`, "");
    lines.push(
      "| Action | Plugin | Risk | Capabilities | Surfaces | Description |",
    );
    lines.push("| --- | --- | :---: | --- | --- | --- |");
    for (const entry of actions.filter(
      (action) => (action._domain ?? "(untagged)") === domain,
    )) {
      lines.push(
        [
          `\`${entry.function.name}\``,
          entry._plugin,
          entry._risk ?? "-",
          entry._capabilities
            .map((tag) => tag.replace("capability:", ""))
            .join(", "),
          entry._surfaces.map((tag) => tag.replace("surface:", "")).join(", "),
          truncateForTable(entry.function.description),
        ]
          .join(" | ")
          .replace(/^/, "| ")
          .replace(/$/, " |"),
      );
    }
    lines.push("");
  }

  while (lines.at(-1) === "") {
    lines.pop();
  }
  return `${lines.join("\n")}\n`;
}

function countBy<T>(
  items: T[],
  keyFn: (item: T) => string,
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) {
    const key = keyFn(item);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function renderCountRows(counts: Map<string, number>): string[] {
  return [...counts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, count]) => `| ${key} | ${count} |`);
}

function truncateForTable(value: string): string {
  const escaped = value.replace(/\s+/g, " ").replace(/\|/g, "\\|").trim();
  return escaped.length <= 96 ? escaped : `${escaped.slice(0, 95)}...`;
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  const sourcePlugins = [
    appContactsPlugin,
    personalAssistantPlugin,
    appPhonePlugin,
    blueBubblesPlugin,
    imessagePlugin,
    todosPlugin,
  ];
  const entries = filterEntries(collectEntries(sourcePlugins), options);
  const manifest: Manifest = {
    schemaVersion: 1,
    generator: "scripts/lifeops-bench/export-action-manifest.ts",
    sourcePlugins: sourcePlugins.map((plugin) => plugin.name),
    filters: {
      domains: options.domains,
      capabilities: options.capabilities,
      surfaces: options.surfaces,
      excludeRisks: options.excludeRisks,
      benchUmbrellaAugment: options.benchUmbrellaAugment,
    },
    actions: entries,
  };

  writeJson(options.out, manifest);
  if (options.benchUmbrellaAugment) {
    augmentWithBenchUmbrellas(options.out);
  }

  const finalManifest = JSON.parse(
    readFileSync(options.out, "utf8"),
  ) as Manifest;
  if (options.summaryOut) {
    mkdirSync(dirname(options.summaryOut), { recursive: true });
    writeFileSync(options.summaryOut, renderSummary(finalManifest), "utf8");
  }
  console.log(
    `wrote ${options.out} (${finalManifest.actions.length} actions)` +
      (options.summaryOut ? ` and ${options.summaryOut}` : ""),
  );
}

main();
