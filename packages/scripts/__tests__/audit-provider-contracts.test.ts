/** Tests the provider-contract inventory ratchet against the repository declarations. */

import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { auditProviderContracts } from "../audit-provider-contracts.mjs";

const temporaryRoots: string[] = [];
const FULL_REPOSITORY_AUDIT_TIMEOUT_MS = 75_000;

async function writeProtectedLedger(root: string, integrationIds: string[]) {
  const inventoryDirectory = path.join(root, "packages/cloud/test-mocks");
  await mkdir(inventoryDirectory, { recursive: true });
  await writeFile(
    path.join(
      inventoryDirectory,
      "provider-contract-protected-integrations.json",
    ),
    JSON.stringify({ version: 1, integrationIds }),
  );
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

describe("provider contract inventory audit", () => {
  test(
    "accepts the checked-in promoted integration suites",
    async () => {
      const result = await auditProviderContracts();
      const ledger = JSON.parse(
        await readFile(
          path.join(
            process.cwd(),
            "packages/cloud/test-mocks/provider-contract-protected-integrations.json",
          ),
          "utf8",
        ),
      );
      expect(result.count).toBeGreaterThanOrEqual(2);
      const inventory = JSON.parse(
        await readFile(
          path.join(
            process.cwd(),
            "packages/cloud/test-mocks/provider-contract-inventory.json",
          ),
          "utf8",
        ),
      );
      expect(result.ids).toEqual(
        inventory.integrations.map((entry: { id: string }) => entry.id).sort(),
      );
      expect(ledger.integrationIds).toContain("whatsapp-cloud-webhook");
    },
    FULL_REPOSITORY_AUDIT_TIMEOUT_MS,
  );

  test("rejects removal of a protected integration without trusting inventory metadata", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "provider-contract-audit-"));
    temporaryRoots.push(root);
    const inventoryDirectory = path.join(root, "packages/cloud/test-mocks");
    await mkdir(inventoryDirectory, { recursive: true });
    await writeFile(
      path.join(inventoryDirectory, "provider-contract-inventory.json"),
      JSON.stringify({
        version: 1,
        retiredIntegrations: [],
        integrations: [],
      }),
    );
    await writeProtectedLedger(root, []);
    await expect(auditProviderContracts(root)).rejects.toThrow(
      "may not remove historically protected integration eliza-cloud-api",
    );
  });

  test("rejects a promoted package that omits the central inventory", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "provider-contract-audit-"));
    temporaryRoots.push(root);
    const inventoryDirectory = path.join(root, "packages/cloud/test-mocks");
    const fixtureDirectory = path.join(root, "fixtures");
    await mkdir(inventoryDirectory, { recursive: true });
    await mkdir(fixtureDirectory, { recursive: true });
    const integrations = [];
    for (const id of ["eliza-cloud-api", "hetzner-cloud", "missing"]) {
      const packageDirectory = path.join(root, "packages", id);
      await mkdir(packageDirectory, { recursive: true });
      await writeFile(
        path.join(packageDirectory, "package.json"),
        JSON.stringify({
          elizaos: {
            managedIntegration: { promoted: true, contractId: id },
          },
        }),
      );
      await writeFile(
        path.join(packageDirectory, "contract.test.ts"),
        'runProviderAdapterConformance; "success";',
      );
      if (id !== "missing") {
        integrations.push({
          id,
          adapterName: id,
          profile: "outbound-http",
          package: `packages/${id}`,
          suite: `packages/${id}/contract.test.ts`,
          fixtureDirectory: "fixtures",
          capabilities: ["http-read"],
          liveLaneRequiredInForks: false,
        });
      }
    }
    await writeFile(
      path.join(inventoryDirectory, "provider-contract-inventory.json"),
      JSON.stringify({ version: 1, retiredIntegrations: [], integrations }),
    );
    await writeProtectedLedger(root, ["eliza-cloud-api", "hetzner-cloud"]);
    await expect(auditProviderContracts(root)).rejects.toThrow(
      "packages/missing promotes missing without a matching provider contract inventory entry",
    );
  });

  test("rejects a capability without a matching executed observation", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "provider-contract-audit-"));
    temporaryRoots.push(root);
    const inventoryDirectory = path.join(root, "packages/cloud/test-mocks");
    const fixtureDirectory = path.join(root, "fixtures");
    await mkdir(inventoryDirectory, { recursive: true });
    await mkdir(fixtureDirectory, { recursive: true });
    const alwaysRequired = [
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
    const integrations = [];
    for (const id of ["eliza-cloud-api", "hetzner-cloud"]) {
      const packageDirectory = path.join(root, "packages", id);
      await mkdir(packageDirectory, { recursive: true });
      await writeFile(
        path.join(packageDirectory, "package.json"),
        JSON.stringify({
          elizaos: {
            managedIntegration: { promoted: true, contractId: id },
          },
        }),
      );
      const adapterName = `${id}-adapter`;
      const capabilities =
        id === "eliza-cloud-api" ? ["http-read", "http-write"] : ["http-read"];
      const observations = alwaysRequired;
      await writeFile(
        path.join(packageDirectory, "contract.test.ts"),
        `/** Emits a deterministic audit fixture report from an executed Bun test. */
import { test } from "bun:test";
import { appendFileSync } from "node:fs";
test("emits observations", () => {
  appendFileSync(process.env.ELIZA_PROVIDER_CONTRACT_REPORT_PATH, JSON.stringify({
    version: 1,
    nonce: process.env.ELIZA_PROVIDER_CONTRACT_REPORT_NONCE,
    adapterName: ${JSON.stringify(adapterName)},
    profile: "outbound-http",
    capabilities: ${JSON.stringify(capabilities)},
    requiredScenarios: ${JSON.stringify(
      id === "eliza-cloud-api"
        ? [...alwaysRequired, "write-policy-receipt"]
        : alwaysRequired,
    )},
    executedObservations: ${JSON.stringify(observations)}
  }) + "\\n");
});
`,
      );
      integrations.push({
        id,
        adapterName,
        profile: "outbound-http",
        package: `packages/${id}`,
        suite: `packages/${id}/contract.test.ts`,
        fixtureDirectory: "fixtures",
        capabilities,
        liveLaneRequiredInForks: false,
      });
    }
    await writeFile(
      path.join(inventoryDirectory, "provider-contract-inventory.json"),
      JSON.stringify({ version: 1, retiredIntegrations: [], integrations }),
    );
    await writeProtectedLedger(root, ["eliza-cloud-api", "hetzner-cloud"]);
    await expect(auditProviderContracts(root)).rejects.toThrow(
      "eliza-cloud-api did not execute required capability observations: write-policy-receipt",
    );
  });

  test("rejects duplicate capabilities", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "provider-contract-audit-"));
    temporaryRoots.push(root);
    const inventoryDirectory = path.join(root, "packages/cloud/test-mocks");
    await mkdir(inventoryDirectory, { recursive: true });
    await writeFile(
      path.join(inventoryDirectory, "provider-contract-inventory.json"),
      JSON.stringify({
        version: 1,
        retiredIntegrations: [],
        integrations: [
          {
            id: "eliza-cloud-api",
            adapterName: "duplicate-adapter",
            profile: "outbound-http",
            package: "packages/duplicate",
            suite: "packages/duplicate/contract.test.ts",
            fixtureDirectory: "fixtures",
            capabilities: ["http-read", "http-read"],
            liveLaneRequiredInForks: false,
          },
          {
            id: "hetzner-cloud",
            adapterName: "other-adapter",
            profile: "outbound-http",
            package: "packages/other",
            suite: "packages/other/contract.test.ts",
            fixtureDirectory: "fixtures",
            capabilities: ["http-read"],
            liveLaneRequiredInForks: false,
          },
        ],
      }),
    );
    await writeProtectedLedger(root, ["eliza-cloud-api", "hetzner-cloud"]);
    await expect(auditProviderContracts(root)).rejects.toThrow(
      "eliza-cloud-api declares duplicate capabilities",
    );
  });

  test("requires every future inventory id in the append-only ledger", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "provider-contract-audit-"));
    temporaryRoots.push(root);
    const inventoryDirectory = path.join(root, "packages/cloud/test-mocks");
    await mkdir(inventoryDirectory, { recursive: true });
    await writeFile(
      path.join(inventoryDirectory, "provider-contract-inventory.json"),
      JSON.stringify({
        version: 1,
        retiredIntegrations: [],
        integrations: [
          { id: "eliza-cloud-api" },
          { id: "hetzner-cloud" },
          { id: "future-provider" },
        ],
      }),
    );
    await writeProtectedLedger(root, ["eliza-cloud-api", "hetzner-cloud"]);
    await expect(auditProviderContracts(root)).rejects.toThrow(
      "missing from ledger: future-provider",
    );
  });

  test("requires every ledger id in the current inventory", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "provider-contract-audit-"));
    temporaryRoots.push(root);
    const inventoryDirectory = path.join(root, "packages/cloud/test-mocks");
    await mkdir(inventoryDirectory, { recursive: true });
    await writeFile(
      path.join(inventoryDirectory, "provider-contract-inventory.json"),
      JSON.stringify({
        version: 1,
        retiredIntegrations: [],
        integrations: [{ id: "eliza-cloud-api" }, { id: "hetzner-cloud" }],
      }),
    );
    await writeProtectedLedger(root, [
      "eliza-cloud-api",
      "hetzner-cloud",
      "orphaned-provider",
    ]);
    await expect(auditProviderContracts(root)).rejects.toThrow(
      "missing from inventory: orphaned-provider",
    );
  });

  test("rejects deleting an id from both files after it appeared in reachable history", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "provider-contract-audit-"));
    temporaryRoots.push(root);
    const inventoryDirectory = path.join(root, "packages/cloud/test-mocks");
    await mkdir(inventoryDirectory, { recursive: true });
    const inventoryPath = path.join(
      inventoryDirectory,
      "provider-contract-inventory.json",
    );
    const initialIds = [
      "eliza-cloud-api",
      "hetzner-cloud",
      "transient-provider",
    ];
    await writeFile(
      inventoryPath,
      JSON.stringify({
        version: 1,
        retiredIntegrations: [],
        integrations: initialIds.map((id) => ({ id })),
      }),
    );
    await writeProtectedLedger(root, initialIds);
    for (const args of [
      ["init"],
      ["config", "user.name", "Audit Test"],
      ["config", "user.email", "audit@example.invalid"],
      ["add", "."],
      ["commit", "-m", "add transient provider"],
    ]) {
      const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
      expect(result.status, result.stderr).toBe(0);
    }
    const finalIds = ["eliza-cloud-api", "hetzner-cloud"];
    await writeFile(
      inventoryPath,
      JSON.stringify({
        version: 1,
        retiredIntegrations: [],
        integrations: finalIds.map((id) => ({ id })),
      }),
    );
    await writeProtectedLedger(root, finalIds);
    for (const args of [
      ["add", "."],
      ["commit", "-m", "delete transient provider"],
    ]) {
      const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
      expect(result.status, result.stderr).toBe(0);
    }
    await expect(auditProviderContracts(root)).rejects.toThrow(
      "may not remove historically protected integration transient-provider",
    );
  });
});
