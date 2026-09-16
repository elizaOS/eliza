#!/usr/bin/env node
/**
 * Checks the unified design dependency graph against an exact debt ledger and
 * emits deterministic Markdown or JSON for review without rewriting reports.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  buildDesignContractGraph,
  type DesignContractGraph,
} from "./design-contract-inventory.ts";
import {
  compareDesignDebt,
  type DesignDebtComparison,
  type DesignDebtLedger,
  parseDesignDebtLedger,
} from "./design-contract-schema.ts";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const debtPath = path.join(scriptDir, "design-contract-debt.json");

export interface DesignContractReport {
  schemaVersion: 1;
  debtMode: "normal" | "tight";
  scannedFiles: number;
  counts: {
    nodes: number;
    edges: number;
    tokens: number;
    atoms: number;
    molecules: number;
    organisms: number;
    pageShells: number;
    findings: number;
    paintedRawHostObservations: number;
    interactiveRawHostObservations: number;
    declaredTokens: number;
    classifiedBuiltinRoutes: number;
    discoveredComponents: number;
    inferredMolecules: number;
    rawCapabilitiesInInferredMolecules: number;
  };
  graph: DesignContractGraph;
  debt: DesignDebtLedger;
  debtComparison: DesignDebtComparison;
}

function readDebtLedger(): DesignDebtLedger {
  const raw: unknown = JSON.parse(fs.readFileSync(debtPath, "utf8"));
  return parseDesignDebtLedger(raw);
}

export async function buildDesignContractReport(
  options: {
    now?: Date;
    ledger?: DesignDebtLedger;
    debtMode?: "normal" | "tight";
  } = {},
): Promise<DesignContractReport> {
  const graph = await buildDesignContractGraph();
  const debt = options.ledger ?? readDebtLedger();
  const debtComparison = compareDesignDebt(
    graph.findings,
    debt,
    options.now ?? new Date(),
  );
  const countLayer = (layer: string): number =>
    graph.nodes.filter((node) => node.layer === layer).length;

  return {
    schemaVersion: 1,
    debtMode: options.debtMode ?? "normal",
    scannedFiles: graph.scannedFiles,
    counts: {
      nodes: graph.nodes.length,
      edges: graph.edges.length,
      tokens: countLayer("token"),
      atoms: countLayer("atom"),
      molecules: countLayer("molecule"),
      organisms: countLayer("organism"),
      pageShells: countLayer("page-shell"),
      findings: graph.findings.length,
      paintedRawHostObservations: graph.observations.paintedRawHosts.length,
      interactiveRawHostObservations:
        graph.observations.interactiveRawHosts.length,
      declaredTokens: graph.observations.tokens.length,
      classifiedBuiltinRoutes:
        graph.observations.classifiedBuiltinRoutes.length,
      discoveredComponents: graph.observations.discoveredComponents.length,
      inferredMolecules: graph.observations.discoveredComponents.filter(
        (component) => component.inferredLayer === "molecule",
      ).length,
      rawCapabilitiesInInferredMolecules:
        graph.observations.discoveredComponents
          .filter((component) => component.inferredLayer === "molecule")
          .reduce(
            (total, component) => total + component.rawCapabilities.length,
            0,
          ),
    },
    graph,
    debt,
    debtComparison,
  };
}

export function renderDesignContractMarkdown(
  report: DesignContractReport,
): string {
  const lines = [
    "# Design contract graph",
    "",
    `Scanned ${report.scannedFiles} maintained React source files.`,
    "",
    "| Layer | Nodes |",
    "| --- | ---: |",
    `| token | ${report.counts.tokens} |`,
    `| atom | ${report.counts.atoms} |`,
    `| molecule | ${report.counts.molecules} |`,
    `| organism | ${report.counts.organisms} |`,
    `| page-shell | ${report.counts.pageShells} |`,
    "",
    `Edges: ${report.counts.edges}. Findings: ${report.counts.findings}.`,
    "",
    "## Higher-order declaration boundary",
    "",
    `- Declared organisms: ${report.counts.organisms}`,
    `- Declared page shells: ${report.counts.pageShells}`,
    "",
    `The canonical PageFrame owner supports every framed layout kind used by all ${report.counts.classifiedBuiltinRoutes} classified built-in route ids. Ambient routes are explicit topology exceptions and cannot instantiate PageFrame. Mounted topology tests separately prove the current host integration.`,
    "",
    "## Repository observations",
    "",
    `- Parsed semantic token declarations: ${report.counts.declaredTokens}`,
    `- Static raw hosts with surface-paint signals: ${report.counts.paintedRawHostObservations}`,
    `- Non-native hosts with interaction signals: ${report.counts.interactiveRawHostObservations}`,
    `- Classified built-in route ids: ${report.counts.classifiedBuiltinRoutes}`,
    `- Discovered React component owners: ${report.counts.discoveredComponents}`,
    `- Source-inferred reusable molecule owners: ${report.counts.inferredMolecules}`,
    `- Raw capability claims inside inferred molecules: ${report.counts.rawCapabilitiesInInferredMolecules}`,
    "",
    "Repository-wide raw-host counts remain migration inventory. Raw capability claims inside source-inferred molecules are promoted to exact findings below: new claims fail immediately, and reductions make tight mode reject stale debt until the ledger is ratcheted.",
    "",
    "## Findings",
    "",
  ];
  if (report.graph.findings.length === 0) lines.push("None.", "");
  else {
    for (const finding of report.graph.findings) {
      lines.push(
        `- \`${finding.rule}\` \`${finding.owner}\`: ${finding.detail} (\`${finding.fingerprint}\`)`,
      );
    }
    lines.push("");
  }
  lines.push(
    "## Debt status",
    "",
    `- Enforcement mode: ${report.debtMode}`,
    `- Active ledger entries: ${report.debt.entries.length}`,
    `- New findings: ${report.debtComparison.newFindings.length}`,
    `- Stale debt: ${report.debtComparison.staleDebt.length}`,
    `- Expired debt: ${report.debtComparison.expiredDebt.length}`,
    "",
  );
  return `${lines.join("\n").trimEnd()}\n`;
}

export function assertDesignContractReport(report: DesignContractReport): void {
  const failures = [
    ...report.debtComparison.newFindings.map(
      (finding) => `new ${finding.rule} at ${finding.owner}`,
    ),
    ...(report.debtMode === "tight"
      ? report.debtComparison.staleDebt.map(
          (entry) =>
            `stale debt ${entry.fingerprint} expected=${entry.matchCount} at ${entry.owner}`,
        )
      : []),
    ...report.debtComparison.expiredDebt.map(
      (entry) => `expired debt ${entry.fingerprint} reviewBy=${entry.reviewBy}`,
    ),
  ];
  if (failures.length > 0) {
    throw new Error(`Design contract graph failed: ${failures.join("; ")}`);
  }
}

async function main(): Promise<void> {
  const report = await buildDesignContractReport({
    debtMode: process.argv.includes("--require-tight-debt")
      ? "tight"
      : "normal",
  });
  assertDesignContractReport(report);
  if (process.argv.includes("--json")) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(renderDesignContractMarkdown(report));
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  main().catch((error: unknown) => {
    // error-policy:J1 The CLI boundary reports a typed audit failure and exits non-zero.
    process.stderr.write(
      `[design-contract-graph] ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
