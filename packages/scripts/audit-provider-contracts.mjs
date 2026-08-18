/** Ratchets promoted managed integrations to deterministic provider contract suites. */

import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const INVENTORY_PATH =
  "packages/cloud/test-mocks/provider-contract-inventory.json";

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
  if (
    !Number.isInteger(inventory.baselineCount) ||
    inventory.baselineCount < 2 ||
    inventory.integrations.length < inventory.baselineCount
  ) {
    throw new Error(
      `provider contract inventory fell below its ${inventory.baselineCount} integration baseline`,
    );
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
    if (entry.liveLaneRequiredInForks !== false) {
      throw new Error(
        `${entry.id} may not require a secret-bearing live lane in fork CI`,
      );
    }
    if (!Array.isArray(entry.scenarios) || entry.scenarios.length === 0) {
      throw new Error(
        `${entry.id} must declare at least one contract scenario`,
      );
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
    if (!suite.includes("runProviderAdapterConformance")) {
      throw new Error(
        `${entry.id} suite does not run the adapter conformance helper`,
      );
    }
    for (const scenario of entry.scenarios) {
      if (!suite.includes(`"${scenario}"`)) {
        throw new Error(
          `${entry.id} suite does not declare scenario ${scenario}`,
        );
      }
    }
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

  return { count: inventory.integrations.length, ids: [...ids].sort() };
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
