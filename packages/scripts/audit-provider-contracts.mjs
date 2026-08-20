/** Ratchets promoted managed integrations to deterministic provider contract suites. */

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const INVENTORY_PATH =
  "packages/cloud/test-mocks/provider-contract-inventory.json";
const PROTECTED_LEDGER_PATH =
  "packages/cloud/test-mocks/provider-contract-protected-integrations.json";
const BOOTSTRAP_PROTECTED_INTEGRATION_IDS = [
  "eliza-cloud-api",
  "hetzner-cloud",
];
const REPORT_PATH_ENV = "ELIZA_PROVIDER_CONTRACT_REPORT_PATH";
const REPORT_NONCE_ENV = "ELIZA_PROVIDER_CONTRACT_REPORT_NONCE";
const BUN_EXECUTABLE = process.versions.bun ? process.execPath : "bun";
const CONTRACT_SUITE_TIMEOUT_MS = 30_000;
const PROFILE_SCENARIOS = {
  "outbound-http": [
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
  ],
  "inbound-webhook": [
    "success",
    "designed-empty",
    "invalid-input",
    "malformed-json",
    "schema-drift",
    "provider-4xx",
    "provider-5xx",
    "secret-redaction",
    "read-policy",
  ],
};
const CAPABILITY_SCENARIOS = {
  oauth: ["oauth-state-pkce"],
  "oauth-credential-lifecycle": [
    "oauth-refresh-rotation",
    "oauth-revoked-credential",
    "oauth-expired-credential",
  ],
  "http-read": [],
  "http-write": ["write-policy-receipt"],
  "irreversible-write": ["irreversible-policy-receipt"],
  pagination: ["pagination-cursors"],
  streaming: ["streaming-protocol"],
  "media-multimodal": ["media-multimodal"],
  cancellation: ["request-cancellation"],
  concurrency: ["concurrent-isolation"],
  idempotency: ["idempotent-retry"],
  "message-lifecycle": ["message-lifecycle"],
  "tenant-isolation": ["cross-tenant-denial"],
  webhooks: [
    "duplicate-webhook",
    "out-of-order-webhook",
    "webhook-idempotency",
  ],
};
const KNOWN_SCENARIOS = new Set([
  ...Object.values(PROFILE_SCENARIOS).flat(),
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

function idsFromHistoricalDocument(document, source) {
  if (Array.isArray(document.integrations)) {
    return document.integrations.map((entry) => entry.id);
  }
  if (Array.isArray(document.integrationIds)) {
    return document.integrationIds;
  }
  throw new Error(`${source} has no provider integration ids`);
}

function readHistoricalDocument(root, revision, target) {
  const result = spawnSync("git", ["show", `${revision}:${target}`], {
    cwd: root,
    encoding: "utf8",
  });
  if (result.status !== 0) return undefined;
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    // error-policy:J2 Preserve the historical revision and path that made the
    // append-only audit impossible to evaluate.
    throw new Error(
      `invalid provider contract history at ${revision}:${target}`,
      {
        cause: error,
      },
    );
  }
}

function reachableProtectedIntegrationIds(root) {
  const protectedIds = new Set(BOOTSTRAP_PROTECTED_INTEGRATION_IDS);
  const revisions = spawnSync(
    "git",
    ["rev-list", "HEAD", "--", INVENTORY_PATH, PROTECTED_LEDGER_PATH],
    { cwd: root, encoding: "utf8" },
  );
  // Synthetic audit roots and shallow checkouts may have no reachable history.
  // The checked-in ledger remains authoritative in that case; whenever Git
  // history is available, every integration id ever committed stays protected.
  if (revisions.status !== 0) return protectedIds;
  for (const revision of revisions.stdout.split("\n").filter(Boolean)) {
    for (const target of [INVENTORY_PATH, PROTECTED_LEDGER_PATH]) {
      const document = readHistoricalDocument(root, revision, target);
      if (!document) continue;
      for (const id of idsFromHistoricalDocument(
        document,
        `${revision}:${target}`,
      )) {
        if (typeof id === "string" && id) protectedIds.add(id);
      }
    }
  }
  return protectedIds;
}

async function assertProtectedLedger(root, inventoryIds) {
  const ledger = JSON.parse(
    await readFile(path.join(root, PROTECTED_LEDGER_PATH), "utf8"),
  );
  if (ledger.version !== 1 || !Array.isArray(ledger.integrationIds)) {
    throw new Error(
      "provider contract protected ledger must use schema version 1",
    );
  }
  const ledgerIds = new Set();
  for (const id of ledger.integrationIds) {
    if (typeof id !== "string" || !id || ledgerIds.has(id)) {
      throw new Error(
        `provider contract protected ledger has duplicate or empty id: ${id}`,
      );
    }
    ledgerIds.add(id);
  }
  const absentFromLedger = [...inventoryIds].filter((id) => !ledgerIds.has(id));
  const absentFromInventory = [...ledgerIds].filter(
    (id) => !inventoryIds.has(id),
  );
  if (absentFromLedger.length > 0 || absentFromInventory.length > 0) {
    throw new Error(
      `provider contract inventory and protected ledger must contain exactly the same ids (missing from ledger: ${absentFromLedger.join(", ") || "none"}; missing from inventory: ${absentFromInventory.join(", ") || "none"})`,
    );
  }
  for (const protectedId of reachableProtectedIntegrationIds(root)) {
    if (!ledgerIds.has(protectedId)) {
      throw new Error(
        `provider contract ratchet may not remove historically protected integration ${protectedId}`,
      );
    }
  }
}

export async function auditProviderContracts(root = process.cwd()) {
  const inventory = JSON.parse(
    await readFile(path.join(root, INVENTORY_PATH), "utf8"),
  );
  if (inventory.version !== 1 || !Array.isArray(inventory.integrations)) {
    throw new Error("provider contract inventory must use schema version 1");
  }

  const ids = new Set();
  for (const entry of inventory.integrations) {
    if (!entry.id || ids.has(entry.id)) {
      throw new Error(
        `provider contract inventory has duplicate or empty id: ${entry.id}`,
      );
    }
    ids.add(entry.id);
  }
  await assertProtectedLedger(root, ids);

  const packages = new Map();
  for (const entry of inventory.integrations) {
    if (typeof entry.adapterName !== "string" || !entry.adapterName) {
      throw new Error(`${entry.id} is missing adapterName`);
    }
    if (!(entry.profile in PROFILE_SCENARIOS)) {
      throw new Error(
        `${entry.id} declares unknown provider profile ${entry.profile}`,
      );
    }
    if (entry.liveLaneRequiredInForks !== false) {
      throw new Error(
        `${entry.id} may not require a secret-bearing live lane in fork CI`,
      );
    }
    if (!Array.isArray(entry.capabilities) || entry.capabilities.length === 0) {
      throw new Error(`${entry.id} must declare at least one capability`);
    }
    if (new Set(entry.capabilities).size !== entry.capabilities.length) {
      throw new Error(`${entry.id} declares duplicate capabilities`);
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

function requiredScenarios(profile, capabilities) {
  return [
    ...new Set([
      ...PROFILE_SCENARIOS[profile],
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
  const coveragePath = `${reportPath}.coverage`;
  try {
    const result = spawnSync(
      BUN_EXECUTABLE,
      [
        "--conditions=eliza-source",
        "test",
        "--coverage-reporter=lcov",
        `--coverage-dir=${coveragePath}`,
        entry.suite,
      ],
      {
        cwd: root,
        env: {
          ...process.env,
          [REPORT_PATH_ENV]: reportPath,
          [REPORT_NONCE_ENV]: nonce,
        },
        encoding: "utf8",
        maxBuffer: 32 * 1024 * 1024,
        timeout: CONTRACT_SUITE_TIMEOUT_MS,
      },
    );
    if (result.error) {
      if (result.error.code === "ETIMEDOUT") {
        throw new Error(
          `${entry.id} contract suite exceeded the ${CONTRACT_SUITE_TIMEOUT_MS}ms audit deadline`,
          { cause: result.error },
        );
      }
      throw result.error;
    }
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
    if (report.profile !== entry.profile) {
      throw new Error(
        `${entry.id} executed profile ${report.profile} does not match inventory ${entry.profile}`,
      );
    }
    const required = requiredScenarios(entry.profile, entry.capabilities);
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
    await rm(coveragePath, { force: true, recursive: true });
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
