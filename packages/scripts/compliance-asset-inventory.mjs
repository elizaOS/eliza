#!/usr/bin/env node
/**
 * Validates the repository-owned compliance asset registry and derives portable
 * network/control views from it. The audit deliberately distinguishes source-
 * backed facts from protected operator assertions; unresolved assertions remain
 * visible holds and become failures only under `--strict`.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  atomicWriteFileSync,
  atomicWriteJsonSync,
  resolveReportArtifactPath,
} from "./lib/report-artifact-path.mjs";
import {
  assertContainedRegularFile,
  assertUniqueRepositoryIdentities,
  normalizeGitRepositoryPath,
} from "./lib/repository-file-integrity.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..", "..");
const INVENTORY_PATH = ".github/compliance/asset-inventory.json";
const DEFAULT_JSON_REPORT = "reports/compliance/asset-inventory.json";
const DEFAULT_MARKDOWN_REPORT = "reports/compliance/asset-inventory.md";

const FACT_KEYS = [
  "owner",
  "environments",
  "tenantBoundary",
  "dataClasses",
  "provider",
  "regions",
  "ingress",
  "egress",
  "identities",
  "encryption",
  "retention",
  "backups",
  "monitoring",
  "lifecycle",
  "ephiHandling",
];
const ASSERTION_STATUSES = new Set([
  "source-verified",
  "policy",
  "operator-review-required",
]);
const DESCRIPTOR_PATTERNS = [
  /(?:^|\/)wrangler[^/]*\.(?:toml|json|jsonc)$/,
  /(?:^|\/)railway\.toml$/,
  /(?:^|\/)(?:docker-)?compose[^/]*\.ya?ml$/,
  /\.tf$/,
  /(?:^|\/)Dockerfile[^/]*$/,
  /AndroidManifest\.xml$/,
  /^packages\/app-core\/platforms\/(?:ios|electrobun)\/.*(?:Info\.plist|\.entitlements)$/,
];

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function requireObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function requireExactKeys(value, allowed, label) {
  const extras = Object.keys(value).filter((key) => !allowed.includes(key));
  if (extras.length > 0) {
    throw new Error(
      `${label} contains unsupported fields: ${extras.join(", ")}`,
    );
  }
}

function requireString(value, label) {
  if (
    typeof value !== "string" ||
    value.trim() !== value ||
    value.length === 0
  ) {
    throw new Error(`${label} must be a non-empty trimmed string`);
  }
  return value;
}

function requireStringArray(value, label, { allowEmpty = false } = {}) {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) {
    throw new Error(
      `${label} must be ${allowEmpty ? "an" : "a non-empty"} array`,
    );
  }
  const strings = value.map((entry, index) =>
    requireString(entry, `${label}[${index}]`),
  );
  assertUniqueRepositoryIdentities(
    strings,
    `${label} contains duplicate identities`,
  );
  return strings;
}

function listTrackedRepositoryFiles(repoRoot) {
  const files = execFileSync("git", ["-C", repoRoot, "ls-files", "-z"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  })
    .split("\0")
    .filter(Boolean)
    .map((file) => normalizeGitRepositoryPath(file, "tracked repository file"));
  assertUniqueRepositoryIdentities(files, "tracked repository files collide");
  return files;
}

function validateEvidenceReferences(
  value,
  label,
  {
    repoRoot,
    trackedFiles,
    required = false,
    allowedSources,
    requiredSupports = [],
  },
) {
  if (!Array.isArray(value) || (required && value.length === 0)) {
    throw new Error(
      `${label} must be ${required ? "a non-empty" : "an"} array`,
    );
  }
  const references = value.map((candidate, index) => {
    const entry = requireObject(candidate, `${label}[${index}]`);
    requireExactKeys(
      entry,
      ["path", "supports", "contains"],
      `${label}[${index}]`,
    );
    const reference = normalizeGitRepositoryPath(
      requireString(entry.path, `${label}[${index}].path`),
      `${label}[${index}].path`,
    );
    if (!trackedFiles.has(reference)) {
      throw new Error(
        `${label}[${index}].path is not a tracked repository file: ${reference}`,
      );
    }
    const source = assertContainedRegularFile(
      repoRoot,
      reference,
      `${label}[${index}].path`,
    );
    if (allowedSources && !allowedSources.has(reference)) {
      throw new Error(
        `${label}[${index}].path is not an allowed asset source: ${reference}`,
      );
    }
    const supports = requireStringArray(
      entry.supports,
      `${label}[${index}].supports`,
    );
    const contains = requireStringArray(
      entry.contains,
      `${label}[${index}].contains`,
    );
    const sourceText = readFileSync(source.absolute, "utf8");
    for (const assertion of contains) {
      if (!sourceText.includes(assertion)) {
        throw new Error(
          `${label}[${index}].contains is not present in ${reference}: ${JSON.stringify(assertion)}`,
        );
      }
    }
    return { path: reference, supports, contains };
  });
  assertUniqueRepositoryIdentities(
    references.map((entry) => entry.path),
    `${label} contains duplicate evidence paths`,
  );
  const supported = new Set(references.flatMap((entry) => entry.supports));
  for (const claim of requiredSupports) {
    if (!supported.has(claim)) {
      throw new Error(`${label} does not support asserted value: ${claim}`);
    }
  }
  for (const claim of supported) {
    if (!requiredSupports.includes(claim)) {
      throw new Error(`${label} supports an unasserted value: ${claim}`);
    }
  }
  return references;
}

function validateAssertion(
  value,
  label,
  sourceSet,
  { repoRoot, trackedFiles },
) {
  const assertion = requireObject(value, label);
  requireExactKeys(assertion, ["status", "values", "evidence", "hold"], label);
  const status = requireString(assertion.status, `${label}.status`);
  if (!ASSERTION_STATUSES.has(status)) {
    throw new Error(`${label}.status is unsupported: ${status}`);
  }
  const values = requireStringArray(assertion.values, `${label}.values`, {
    allowEmpty: status === "operator-review-required",
  });
  if (status === "operator-review-required") {
    requireString(assertion.hold, `${label}.hold`);
  } else if (Object.hasOwn(assertion, "hold")) {
    throw new Error(
      `${label}.hold is allowed only for operator-review-required facts`,
    );
  }
  const evidence = validateEvidenceReferences(
    assertion.evidence,
    `${label}.evidence`,
    {
      repoRoot,
      trackedFiles,
      required: status === "source-verified",
      allowedSources: sourceSet,
      requiredSupports: status === "source-verified" ? values : [],
    },
  );
  return { status, values, evidence, hold: assertion.hold };
}

export function isComplianceDeploymentDescriptor(file) {
  const normalized = normalizeGitRepositoryPath(file, "deployment descriptor");
  return DESCRIPTOR_PATTERNS.some((pattern) => pattern.test(normalized));
}

export function discoverComplianceDeploymentDescriptors(repoRoot) {
  const files = listTrackedRepositoryFiles(repoRoot)
    .filter(isComplianceDeploymentDescriptor)
    .sort(compareText);
  assertUniqueRepositoryIdentities(files, "deployment descriptors collide");
  return files;
}

export function validateComplianceInventory(raw, { repoRoot, discovered }) {
  const inventory = requireObject(raw, "inventory");
  requireExactKeys(
    inventory,
    ["schema", "scope", "assets", "flows", "controls"],
    "inventory",
  );
  if (inventory.schema !== 1) throw new Error("inventory.schema must equal 1");
  requireString(inventory.scope, "inventory.scope");
  const assets = Array.isArray(inventory.assets) ? inventory.assets : null;
  if (!assets || assets.length === 0)
    throw new Error("inventory.assets must be non-empty");
  const assetIds = new Set();
  const trackedFiles = new Set(listTrackedRepositoryFiles(repoRoot));
  const registeredSources = new Map();
  const holds = [];
  const normalizedAssets = assets.map((candidate, assetIndex) => {
    const asset = requireObject(candidate, `assets[${assetIndex}]`);
    requireExactKeys(
      asset,
      ["id", "name", "kind", "sources", "facts"],
      `assets[${assetIndex}]`,
    );
    const id = requireString(asset.id, `assets[${assetIndex}].id`);
    if (!/^[a-z][a-z0-9-]*$/.test(id)) {
      throw new Error(`asset id must use lowercase kebab-case: ${id}`);
    }
    if (assetIds.has(id)) throw new Error(`duplicate asset id: ${id}`);
    assetIds.add(id);
    const name = requireString(asset.name, `asset ${id}.name`);
    const kind = requireString(asset.kind, `asset ${id}.kind`);
    const sources = requireStringArray(
      asset.sources,
      `asset ${id}.sources`,
    ).map((source) => normalizeGitRepositoryPath(source, `asset ${id} source`));
    const sourceSet = new Set(sources);
    for (const source of sources) {
      assertContainedRegularFile(repoRoot, source, `asset ${id} source`);
      const previous = registeredSources.get(source);
      if (previous)
        throw new Error(
          `descriptor ${source} belongs to both ${previous} and ${id}`,
        );
      registeredSources.set(source, id);
    }
    const facts = requireObject(asset.facts, `asset ${id}.facts`);
    requireExactKeys(facts, FACT_KEYS, `asset ${id}.facts`);
    const normalizedFacts = {};
    for (const key of FACT_KEYS) {
      normalizedFacts[key] = validateAssertion(
        facts[key],
        `asset ${id}.facts.${key}`,
        sourceSet,
        { repoRoot, trackedFiles },
      );
      if (normalizedFacts[key].status === "operator-review-required") {
        holds.push({
          subject: id,
          field: key,
          hold: normalizedFacts[key].hold,
        });
      }
    }
    return { id, name, kind, sources, facts: normalizedFacts };
  });

  const discoveredSet = new Set(discovered);
  const missing = discovered.filter((source) => !registeredSources.has(source));
  const stale = [...registeredSources.keys()].filter(
    (source) => !discoveredSet.has(source),
  );
  if (missing.length > 0)
    throw new Error(
      `unclassified deployment descriptors: ${missing.join(", ")}`,
    );
  if (stale.length > 0)
    throw new Error(
      `stale registered deployment descriptors: ${stale.join(", ")}`,
    );

  const registeredSourceSet = new Set(registeredSources.keys());

  const flows = Array.isArray(inventory.flows) ? inventory.flows : null;
  if (!flows) throw new Error("inventory.flows must be an array");
  const flowIds = new Set();
  const normalizedFlows = flows.map((candidate, flowIndex) => {
    const flow = requireObject(candidate, `flows[${flowIndex}]`);
    requireExactKeys(
      flow,
      [
        "id",
        "source",
        "destination",
        "dataClasses",
        "status",
        "evidence",
        "hold",
      ],
      `flows[${flowIndex}]`,
    );
    const id = requireString(flow.id, `flows[${flowIndex}].id`);
    if (flowIds.has(id)) throw new Error(`duplicate flow id: ${id}`);
    flowIds.add(id);
    const source = requireString(flow.source, `flow ${id}.source`);
    const destination = requireString(
      flow.destination,
      `flow ${id}.destination`,
    );
    if (!assetIds.has(source) || !assetIds.has(destination)) {
      throw new Error(`flow ${id} references an unknown asset`);
    }
    const dataClasses = requireStringArray(
      flow.dataClasses,
      `flow ${id}.dataClasses`,
    );
    const status = requireString(flow.status, `flow ${id}.status`);
    if (!ASSERTION_STATUSES.has(status))
      throw new Error(`flow ${id}.status is unsupported`);
    const evidence = validateEvidenceReferences(
      flow.evidence,
      `flow ${id}.evidence`,
      {
        repoRoot,
        trackedFiles,
        required: status === "source-verified",
        allowedSources: new Set([
          ...normalizedAssets.find((asset) => asset.id === source).sources,
          ...normalizedAssets.find((asset) => asset.id === destination).sources,
        ]),
        requiredSupports:
          status === "source-verified"
            ? [source, destination, ...dataClasses]
            : [],
      },
    );
    const hold =
      status === "operator-review-required"
        ? requireString(flow.hold, `flow ${id}.hold`)
        : undefined;
    if (status !== "operator-review-required" && Object.hasOwn(flow, "hold")) {
      throw new Error(
        `flow ${id}.hold is allowed only for operator-review-required flows`,
      );
    }
    if (hold) holds.push({ subject: id, field: "flow", hold });
    return { id, source, destination, dataClasses, status, evidence, hold };
  });

  const controls = Array.isArray(inventory.controls)
    ? inventory.controls
    : null;
  if (!controls || controls.length === 0)
    throw new Error("inventory.controls must be non-empty");
  const controlIds = new Set();
  const normalizedControls = controls.map((candidate, index) => {
    const control = requireObject(candidate, `controls[${index}]`);
    requireExactKeys(
      control,
      ["id", "framework", "owner", "status", "evidence", "hold"],
      `controls[${index}]`,
    );
    const id = requireString(control.id, `controls[${index}].id`);
    if (controlIds.has(id)) throw new Error(`duplicate control id: ${id}`);
    controlIds.add(id);
    const framework = requireString(
      control.framework,
      `control ${id}.framework`,
    );
    const owner = requireString(control.owner, `control ${id}.owner`);
    const status = requireString(control.status, `control ${id}.status`);
    if (!ASSERTION_STATUSES.has(status))
      throw new Error(`control ${id}.status is unsupported`);
    const evidence = validateEvidenceReferences(
      control.evidence,
      `control ${id}.evidence`,
      {
        repoRoot,
        trackedFiles,
        required: status === "source-verified",
        allowedSources: registeredSourceSet,
        requiredSupports:
          status === "source-verified" ? [id, framework, owner] : [],
      },
    );
    const hold =
      status === "operator-review-required"
        ? requireString(control.hold, `control ${id}.hold`)
        : undefined;
    if (
      status !== "operator-review-required" &&
      Object.hasOwn(control, "hold")
    ) {
      throw new Error(
        `control ${id}.hold is allowed only for operator-review-required controls`,
      );
    }
    if (hold) holds.push({ subject: id, field: "control", hold });
    return { id, framework, owner, status, evidence, hold };
  });

  return {
    schema: 1,
    scope: inventory.scope,
    assets: normalizedAssets,
    flows: normalizedFlows,
    controls: normalizedControls,
    coverage: {
      discovered: discovered.length,
      registered: registeredSources.size,
    },
    holds,
  };
}

export function renderComplianceInventoryMarkdown(report) {
  const lines = [
    "# Compliance asset inventory",
    "",
    `Scope: ${report.scope}`,
    "",
    "## Network and data-flow map",
    "",
    "```mermaid",
    "flowchart LR",
    ...report.assets.map(
      (asset) =>
        `  ${asset.id.replaceAll("-", "_")}[${JSON.stringify(asset.name)}]`,
    ),
    ...report.flows.map(
      (flow) =>
        `  ${flow.source.replaceAll("-", "_")} -->|${flow.dataClasses.join(", ")}| ${flow.destination.replaceAll("-", "_")}`,
    ),
    "```",
    "",
    "| Flow | Status | Evidence |",
    "| --- | --- | --- |",
    ...report.flows.map(
      (flow) =>
        `| ${flow.id} | ${flow.status} | ${flow.evidence.map((entry) => entry.path).join("<br>") || "none recorded"} |`,
    ),
    "",
    "## Control and evidence ownership",
    "",
    "| Control | Framework | Owner | Status | Evidence |",
    "| --- | --- | --- | --- | --- |",
    ...report.controls.map(
      (control) =>
        `| ${control.id} | ${control.framework} | ${control.owner} | ${control.status} | ${control.evidence.map((entry) => entry.path).join("<br>") || "none recorded"} |`,
    ),
    "",
    "## Protected acceptance holds",
    "",
    ...(report.holds.length === 0
      ? ["None."]
      : report.holds.map(
          (hold) => `- ${hold.subject}.${hold.field}: ${hold.hold}`,
        )),
    "",
  ];
  return `${lines.join("\n")}\n`;
}

export function parseComplianceInventoryArgs(args) {
  const options = {
    strict: false,
    json: false,
    report: DEFAULT_JSON_REPORT,
    markdown: DEFAULT_MARKDOWN_REPORT,
  };
  const seen = new Set();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (["--strict", "--json"].includes(arg)) {
      if (seen.has(arg)) throw new Error(`${arg} may be specified only once`);
      seen.add(arg);
      options[arg.slice(2)] = true;
      continue;
    }
    if (arg === "--report" || arg === "--markdown") {
      if (seen.has(arg)) throw new Error(`${arg} may be specified only once`);
      seen.add(arg);
      const value = args[index + 1];
      if (!value || value.startsWith("-"))
        throw new Error(`${arg} requires a path`);
      const extension = arg === "--report" ? ".json" : ".md";
      options[arg.slice(2)] = resolveReportArtifactPath(REPO_ROOT, value, {
        extension,
        label: arg,
      }).relative;
      index += 1;
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

export function runComplianceInventoryAudit({ repoRoot = REPO_ROOT } = {}) {
  const inventorySource = assertContainedRegularFile(
    repoRoot,
    INVENTORY_PATH,
    "compliance inventory",
  );
  let raw;
  try {
    raw = JSON.parse(readFileSync(inventorySource.absolute, "utf8"));
  } catch (error) {
    throw new Error("compliance inventory is invalid JSON", { cause: error });
  }
  return validateComplianceInventory(raw, {
    repoRoot,
    discovered: discoverComplianceDeploymentDescriptors(repoRoot),
  });
}

function main() {
  const options = parseComplianceInventoryArgs(process.argv.slice(2));
  const report = runComplianceInventoryAudit();
  const jsonPath = resolveReportArtifactPath(REPO_ROOT, options.report, {
    extension: ".json",
    label: "--report",
  });
  const markdownPath = resolveReportArtifactPath(REPO_ROOT, options.markdown, {
    extension: ".md",
    label: "--markdown",
  });
  mkdirSync(path.dirname(jsonPath.absolute), { recursive: true });
  mkdirSync(path.dirname(markdownPath.absolute), { recursive: true });
  atomicWriteJsonSync(jsonPath.absolute, report);
  atomicWriteFileSync(
    markdownPath.absolute,
    renderComplianceInventoryMarkdown(report),
  );
  if (options.json)
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else {
    process.stdout.write(
      `[compliance-inventory] ${report.assets.length} assets, ${report.coverage.registered}/${report.coverage.discovered} descriptors, ${report.holds.length} protected hold(s)\n`,
    );
  }
  if (options.strict && report.holds.length > 0) {
    throw new Error(
      `strict acceptance blocked by ${report.holds.length} protected operator hold(s)`,
    );
  }
}

if (import.meta.main || process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    // error-policy:J1 the CLI boundary turns invalid inventory or unresolved
    // strict acceptance into a non-zero audit result.
    process.stderr.write(
      `[compliance-inventory] ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
