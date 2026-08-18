/** Tests the provider-contract inventory ratchet against the repository declarations. */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { auditProviderContracts } from "../audit-provider-contracts.mjs";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

describe("provider contract inventory audit", () => {
  test("accepts the checked-in promoted integration suites", async () => {
    const result = await auditProviderContracts();
    expect(result.count).toBeGreaterThanOrEqual(2);
    expect(result.ids).toEqual(["eliza-cloud-api", "hetzner-cloud"]);
  });

  test("rejects removal of a protected integration without trusting inventory metadata", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "provider-contract-audit-"));
    temporaryRoots.push(root);
    const inventoryDirectory = path.join(root, "packages/cloud/test-mocks");
    await mkdir(inventoryDirectory, { recursive: true });
    await writeFile(
      path.join(inventoryDirectory, "provider-contract-inventory.json"),
      JSON.stringify({
        version: 1,
        integrations: [],
      }),
    );
    await expect(auditProviderContracts(root)).rejects.toThrow(
      "may not remove protected integration eliza-cloud-api",
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
      JSON.stringify({ version: 1, integrations }),
    );
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
        package: `packages/${id}`,
        suite: `packages/${id}/contract.test.ts`,
        fixtureDirectory: "fixtures",
        capabilities,
        liveLaneRequiredInForks: false,
      });
    }
    await writeFile(
      path.join(inventoryDirectory, "provider-contract-inventory.json"),
      JSON.stringify({ version: 1, integrations }),
    );
    await expect(auditProviderContracts(root)).rejects.toThrow(
      "eliza-cloud-api did not execute required capability observations: write-policy-receipt",
    );
  });
});
