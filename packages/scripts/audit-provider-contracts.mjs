/** Ratchets promoted managed integrations to deterministic provider contract suites. */

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const INVENTORY_PATH =
  "packages/cloud/test-mocks/provider-contract-inventory.json";
const PROTECTED_INTEGRATION_IDS = ["eliza-cloud-api", "hetzner-cloud"];
const REPORT_PATH_ENV = "ELIZA_PROVIDER_CONTRACT_REPORT_PATH";
const REPORT_NONCE_ENV = "ELIZA_PROVIDER_CONTRACT_REPORT_NONCE";
const BUN_EXECUTABLE = process.versions.bun ? process.execPath : "bun";
const ALWAYS_REQUIRED = [
  "success",
  "designed-empty",
  "invalid-input",
  "rate-limit-retry-metadata",
  "malformed-json",
  "schema-drift",
  "timeout",
  "connection-reset",
  "provider-4xx",
  "provider-5xx",
  "opaque-connection-id",
  "secret-redaction",
  "read-policy",
];
const CAPABILITY_SCENARIOS = {
  oauth: [
    "oauth-state-pkce",
    "oauth-refresh-rotation",
    "oauth-revoked-credential",
    "oauth-expired-credential",
  ],
  "http-read": [],
  "http-write": ["write-policy-receipt"],
  "irreversible-write": ["irreversible-policy-receipt"],
  pagination: ["pagination-cursors"],
  "tenant-isolation": ["cross-tenant-denial"],
  webhooks: [
    "duplicate-webhook",
    "out-of-order-webhook",
    "webhook-idempotency",
  ],
};
const KNOWN_SCENARIOS = new Set([
  ...ALWAYS_REQUIRED,
  ...Object.values(CAPABILITY_SCENARIOS).flat(),
]);

async function exists(target) {
  try {
    await stat(target);
    return true;
  } catch (error) {
    // error-policy:J3 A missing inventory target is an explicit invalid result;
    // every other filesystem failure remains fatal to the audit.
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function findPackageManifests(root) {
  const manifests = [];
  const visit = async (directory) => {
    if (!(await exists(directory))) return;
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (["node_modules", "dist", ".git"].includes(entry.name)) continue;
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(target);
      else if (entry.isFile() && entry.name === "package.json") {
        manifests.push(target);
      }
    }
  };
  await visit(path.join(root, "packages"));
  await visit(path.join(root, "plugins"));
  return manifests;
}

export async function auditProviderContracts(root = process.cwd()) {
  const inventory = JSON.parse(
    await readFile(path.join(root, INVENTORY_PATH), "utf8"),
  );
  if (inventory.version !== 1 || !Array.isArray(inventory.integrations)) {
    throw new Error("provider contract inventory must use schema version 1");
  }

  const ids = new Set();
  const packages = new Map();
  for (const entry of inventory.integrations) {
    if (!entry.id || ids.has(entry.id)) {
      throw new Error(
        `provider contract inventory has duplicate or empty id: ${entry.id}`,
      );
    }
    ids.add(entry.id);
    if (typeof entry.adapterName !== "string" || !entry.adapterName) {
      throw new Error(`${entry.id} is missing adapterName`);
    }
    if (entry.liveLaneRequiredInForks !== false) {
      throw new Error(
        `${entry.id} may not require a secret-bearing live lane in fork CI`,
      );
    }
    if (!Array.isArray(entry.capabilities) || entry.capabilities.length === 0) {
      throw new Error(`${entry.id} must declare at least one capability`);
    }
    for (const capability of entry.capabilities) {
      if (!(capability in CAPABILITY_SCENARIOS)) {
        throw new Error(
          `${entry.id} declares unknown capability ${capability}`,
        );
      }
    }
    for (const field of ["package", "suite", "fixtureDirectory"]) {
      if (typeof entry[field] !== "string" || !entry[field]) {
        throw new Error(`${entry.id} is missing ${field}`);
      }
      if (!(await exists(path.join(root, entry[field])))) {
        throw new Error(
          `${entry.id} references missing ${field}: ${entry[field]}`,
        );
      }
    }
    const suite = await readFile(path.join(root, entry.suite), "utf8");
    if (/\.(?:only|skip)\s*\(/.test(suite)) {
      throw new Error(`${entry.id} suite contains focused or skipped tests`);
    }
    packages.set(entry.package, entry.id);
  }

  for (const protectedId of PROTECTED_INTEGRATION_IDS) {
    if (!ids.has(protectedId)) {
      throw new Error(
        `provider contract ratchet may not remove protected integration ${protectedId}`,
      );
    }
  }

  const promotedDeclarations = new Map();
  for (const manifestPath of await findPackageManifests(root)) {
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    const declaration = manifest.elizaos?.managedIntegration;
    if (declaration?.promoted !== true) continue;
    const packageDirectory = path
      .relative(root, path.dirname(manifestPath))
      .split(path.sep)
      .join("/");
    if (typeof declaration.contractId !== "string" || !declaration.contractId) {
      throw new Error(
        `${packageDirectory} promoted integration has no contractId`,
      );
    }
    if (promotedDeclarations.has(declaration.contractId)) {
      throw new Error(
        `duplicate promoted managedIntegration.contractId=${declaration.contractId}`,
      );
    }
    promotedDeclarations.set(declaration.contractId, packageDirectory);
  }

  for (const [contractId, packageDirectory] of promotedDeclarations) {
    if (packages.get(packageDirectory) !== contractId) {
      throw new Error(
        `${packageDirectory} promotes ${contractId} without a matching provider contract inventory entry`,
      );
    }
  }

  for (const [packageDirectory, integrationId] of packages) {
    const manifest = JSON.parse(
      await readFile(path.join(root, packageDirectory, "package.json"), "utf8"),
    );
    const declaration = manifest.elizaos?.managedIntegration;
    if (
      declaration?.promoted !== true ||
      declaration?.contractId !== integrationId
    ) {
      throw new Error(
        `${packageDirectory} must declare promoted managedIntegration.contractId=${integrationId}`,
      );
    }
  }

  for (const entry of inventory.integrations) {
    await assertExecutedObservations(root, entry);
  }

  return { count: inventory.integrations.length, ids: [...ids].sort() };
}

function requiredScenarios(capabilities) {
  return [
    ...new Set([
      ...ALWAYS_REQUIRED,
      ...capabilities.flatMap((capability) => CAPABILITY_SCENARIOS[capability]),
    ]),
  ];
}

async function assertExecutedObservations(root, entry) {
  const nonce = randomUUID();
  const reportPath = path.join(
    tmpdir(),
    `eliza-provider-contract-${process.pid}-${nonce}.ndjson`,
  );
  try {
    const result = spawnSync(BUN_EXECUTABLE, ["test", entry.suite], {
      cwd: root,
      env: {
        ...process.env,
        [REPORT_PATH_ENV]: reportPath,
        [REPORT_NONCE_ENV]: nonce,
      },
      encoding: "utf8",
      timeout: 120_000,
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error(
        `${entry.id} contract suite failed while collecting observations:\n${result.stdout}${result.stderr}`,
      );
    }
    if (!(await exists(reportPath))) {
      throw new Error(`${entry.id} contract suite emitted no execution report`);
    }
    const reports = (await readFile(reportPath, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter(
        (report) =>
          report.version === 1 &&
          report.nonce === nonce &&
          report.adapterName === entry.adapterName,
      );
    if (reports.length !== 1) {
      throw new Error(
        `${entry.id} expected one executed report for ${entry.adapterName}, received ${reports.length}`,
      );
    }
    const report = reports[0];
    if (
      JSON.stringify(report.capabilities) !== JSON.stringify(entry.capabilities)
    ) {
      throw new Error(
        `${entry.id} executed capabilities do not match its inventory declaration`,
      );
    }
    const required = requiredScenarios(entry.capabilities);
    if (!Array.isArray(report.requiredScenarios)) {
      throw new Error(
        `${entry.id} execution report did not declare mandatory scenarios`,
      );
    }
    const reportedRequired = new Set(report.requiredScenarios);
    const unbound = required.filter(
      (scenario) => !reportedRequired.has(scenario),
    );
    if (unbound.length > 0) {
      throw new Error(
        `${entry.id} execution report did not bind capabilities to mandatory scenarios: ${unbound.join(", ")}`,
      );
    }
    if (!Array.isArray(report.executedObservations)) {
      throw new Error(`${entry.id} execution report has no observations`);
    }
    const unknownScenarios = [
      ...report.requiredScenarios,
      ...report.executedObservations,
    ].filter((scenario) => !KNOWN_SCENARIOS.has(scenario));
    if (unknownScenarios.length > 0) {
      throw new Error(
        `${entry.id} execution report contains unknown scenarios: ${[
          ...new Set(unknownScenarios),
        ].join(", ")}`,
      );
    }
    const executed = new Set(report.executedObservations);
    const missing = report.requiredScenarios.filter(
      (scenario) => !executed.has(scenario),
    );
    if (missing.length > 0) {
      throw new Error(
        `${entry.id} did not execute required capability observations: ${missing.join(", ")}`,
      );
    }
    if (executed.size !== report.executedObservations.length) {
      throw new Error(`${entry.id} execution report repeats observations`);
    }
  } finally {
    await rm(reportPath, { force: true });
  }
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const result = await auditProviderContracts();
  process.stdout.write(
    `provider contract inventory: ${result.count} promoted integrations (${result.ids.join(", ")})\n`,
  );
}
