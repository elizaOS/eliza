#!/usr/bin/env node
/**
 * Groups exported React compositions by product role and canonical atomic
 * dependencies. Detection creates a review queue for repeated molecular UI;
 * the committed report requires a final disposition for every cluster.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildInventory } from "./find-duplicate-components.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const reportJson = path.join(
  scriptDir,
  "duplicate-molecular-components-report.json",
);
const reportMarkdown = path.join(
  scriptDir,
  "duplicate-molecular-components-report.md",
);
const decisionsPath = path.join(
  scriptDir,
  "molecular-inventory-decisions.json",
);

const FINAL_DISPOSITIONS = new Set([
  "distinct-domain-compositions",
  "shared-lifecycle-owner",
]);

const ARCHETYPES = [
  ["empty-state", /(EmptyState|Empty|Unavailable|NoResults)$/],
  ["dialog", /(Dialog|Modal|Sheet|Drawer)$/],
  ["form", /(Form|Editor|Composer)$/],
  ["picker", /(Picker|Selector|Chooser|Switcher)$/],
  ["table", /(Table|Grid)$/],
  ["list", /(List|Feed)$/],
  ["card", /(Card|Tile|Widget)$/],
  ["row", /(Row|Item|Cell)$/],
  ["panel", /(Panel|Section|Pane)$/],
  ["header", /(Header|Toolbar|Bar)$/],
  ["navigation", /(Sidebar|Navigation|Nav|Tabs)$/],
];

function archetypeFor(name) {
  return ARCHETYPES.find(([, pattern]) => pattern.test(name))?.[0] ?? null;
}

export function validateMolecularDecisions(clusters, decisions) {
  const clusterSignatures = new Set(
    clusters.map((cluster) => cluster.signature),
  );
  const missingDecisions = clusters
    .filter((cluster) => {
      const decision = decisions[cluster.signature];
      return (
        !decision ||
        typeof decision.disposition !== "string" ||
        typeof decision.rationale !== "string" ||
        decision.rationale.trim().length === 0
      );
    })
    .map((cluster) => cluster.signature);
  const nonFinalDecisions = clusters
    .filter((cluster) => {
      const disposition = decisions[cluster.signature]?.disposition;
      return (
        typeof disposition === "string" &&
        !FINAL_DISPOSITIONS.has(disposition)
      );
    })
    .map(
      (cluster) =>
        `${cluster.signature} (${decisions[cluster.signature].disposition})`,
    );
  const staleDecisions = Object.keys(decisions).filter(
    (signature) => !clusterSignatures.has(signature),
  );

  if (
    missingDecisions.length > 0 ||
    nonFinalDecisions.length > 0 ||
    staleDecisions.length > 0
  ) {
    throw new Error(
      `Molecular decisions must be complete and final. Missing: ${missingDecisions.join(", ") || "none"}; non-final: ${nonFinalDecisions.join(", ") || "none"}; stale: ${staleDecisions.join(", ") || "none"}. Allowed final dispositions: ${[...FINAL_DISPOSITIONS].join(", ")}`,
    );
  }
}

export function buildMolecularInventory() {
  const atomicReport = buildInventory();
  const decisions = JSON.parse(fs.readFileSync(decisionsPath, "utf8"));
  const components = atomicReport.components
    .map((component) => ({
      ...component,
      archetype: archetypeFor(component.name),
    }))
    .filter(
      (component) =>
        component.archetype && component.atomicDependencies.length >= 2,
    );
  const bySignature = new Map();
  for (const component of components) {
    const signature = `${component.archetype}:${component.atomicDependencies.join("+")}`;
    if (!bySignature.has(signature)) bySignature.set(signature, []);
    bySignature.get(signature).push(component);
  }

  const detectedClusters = [...bySignature]
    .map(([signature, entries]) => ({
      archetype: entries[0].archetype,
      atomicDependencies: entries[0].atomicDependencies,
      entries: entries.sort(
        (a, b) =>
          a.file.localeCompare(b.file) ||
          a.line - b.line ||
          a.name.localeCompare(b.name),
      ),
      signature,
    }))
    .filter((cluster) => cluster.entries.length >= 2)
    .sort(
      (a, b) =>
        b.entries.length - a.entries.length ||
        a.signature.localeCompare(b.signature),
    );

  validateMolecularDecisions(detectedClusters, decisions);
  const clusters = detectedClusters.map((cluster) => ({
    ...cluster,
    ...decisions[cluster.signature],
  }));

  return {
    schemaVersion: 1,
    sourceAtomicSchemaVersion: atomicReport.schemaVersion,
    scannedFiles: atomicReport.scannedFiles,
    eligibleComponents: components.length,
    clusters,
    summary: {
      clusterCount: clusters.length,
      clusteredComponents: clusters.reduce(
        (total, cluster) => total + cluster.entries.length,
        0,
      ),
      largestCluster: clusters[0]?.entries.length ?? 0,
    },
  };
}

export function renderMolecularMarkdown(report) {
  const lines = [
    "# Molecular component duplicate inventory",
    "",
    `Scanned ${report.scannedFiles} maintained React files. ${report.eligibleComponents} exported compositions have a recognized molecular role and at least two atomic dependencies.`,
    "",
    "Clusters share both a role and an atomic dependency signature. Detection creates a review queue; this committed report contains only final dispositions based on product behavior, state ownership, and responsive layout.",
    "",
    "| Role | Atomic dependencies | Components | Decision |",
    "| --- | --- | ---: | --- |",
  ];

  for (const cluster of report.clusters) {
    lines.push(
      `| ${cluster.archetype} | ${cluster.atomicDependencies.join(", ")} | ${cluster.entries.length} | ${cluster.disposition} |`,
    );
  }

  lines.push("", "## Reviewed clusters", "");
  for (const cluster of report.clusters) {
    lines.push(
      `### ${cluster.archetype}: ${cluster.atomicDependencies.join(" + ")}`,
      "",
    );
    for (const entry of cluster.entries) {
      lines.push(`- \`${entry.name}\` in \`${entry.file}:${entry.line}\``);
    }
    lines.push(`- Decision: **${cluster.disposition}** — ${cluster.rationale}`);
    lines.push("");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  const report = buildMolecularInventory();
  const markdown = renderMolecularMarkdown(report);
  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (process.argv.includes("--check")) {
    if (
      !fs.existsSync(reportMarkdown) ||
      fs.readFileSync(reportMarkdown, "utf8") !== markdown
    ) {
      throw new Error(
        `${path.basename(reportMarkdown)} is stale. Run bun run --cwd packages/ui audit:molecular-inventory.`,
      );
    }
    process.stdout.write(
      `Molecular inventory is current with ${report.clusters.length} final dispositions.\n`,
    );
  } else {
    fs.writeFileSync(reportJson, json);
    fs.writeFileSync(reportMarkdown, markdown);
    process.stdout.write(markdown);
  }
}
