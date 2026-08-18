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

  test("rejects inventory shrinkage below the checked-in baseline", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "provider-contract-audit-"));
    temporaryRoots.push(root);
    const inventoryDirectory = path.join(root, "packages/cloud/test-mocks");
    await mkdir(inventoryDirectory, { recursive: true });
    await writeFile(
      path.join(inventoryDirectory, "provider-contract-inventory.json"),
      JSON.stringify({
        version: 1,
        baselineCount: 2,
        integrations: [
          {
            id: "only-one",
            package: "packages/only-one",
            suite: "packages/only-one/contract.test.ts",
            fixtureDirectory: "fixtures",
            scenarios: ["success"],
            liveLaneRequiredInForks: false,
          },
        ],
      }),
    );
    await expect(auditProviderContracts(root)).rejects.toThrow(
      "fell below its 2 integration baseline",
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
    for (const id of ["one", "two", "missing"]) {
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
          package: `packages/${id}`,
          suite: `packages/${id}/contract.test.ts`,
          fixtureDirectory: "fixtures",
          scenarios: ["success"],
          liveLaneRequiredInForks: false,
        });
      }
    }
    await writeFile(
      path.join(inventoryDirectory, "provider-contract-inventory.json"),
      JSON.stringify({ version: 1, baselineCount: 2, integrations }),
    );
    await expect(auditProviderContracts(root)).rejects.toThrow(
      "packages/missing promotes missing without a matching provider contract inventory entry",
    );
  });
});
