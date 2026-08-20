/** Validates the provider mock catalog as a complete, non-certifying ownership map. */

import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import {
  buildRuntimeSurfaceInventory,
  RUNTIME_SURFACE_SCHEMA,
} from "../../../scripts/e2e-coverage/runtime-surface-inventory";

type CatalogEntry = {
  id: string;
  family: string;
  ownerShard: string;
  productionClients: string[];
  apiVersions: string[];
  endpoints: string[];
  events: string[];
  fidelity: string;
  gaps: string[];
  control: string;
  scenarios: string[];
  canary: string;
  mockSource: string;
  certification: string;
};

type ProviderMockCatalog = {
  schemaVersion: number;
  controlContract: string;
  certificationPolicy: string;
  inventorySources: string[];
  runtimeSurfaceOwners: Record<string, string>;
  environmentOwners: Record<string, string>;
  mockoonOwners: Record<string, string>;
  contractEvidence: Record<string, string[]>;
  entries: CatalogEntry[];
};

const repoRoot = resolve(import.meta.dir, "../../../..");
const catalog = JSON.parse(
  readFileSync(
    resolve(import.meta.dir, "../provider-mock-catalog.json"),
    "utf8",
  ),
) as ProviderMockCatalog;

function sourceAst(path: string): ts.SourceFile {
  return ts.createSourceFile(
    path,
    readFileSync(resolve(repoRoot, path), "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
}

function exportedStringArray(path: string, name: string): string[] {
  const ast = sourceAst(path);
  for (const statement of ast.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || declaration.name.text !== name)
        continue;
      let initializer = declaration.initializer;
      while (initializer && ts.isAsExpression(initializer))
        initializer = initializer.expression;
      if (!initializer || !ts.isArrayLiteralExpression(initializer))
        throw new Error(`${name} must be an authored array literal`);
      return initializer.elements.map((element) => {
        if (!ts.isStringLiteralLike(element))
          throw new Error(`${name} may contain only string literals`);
        return element.text;
      });
    }
  }
  throw new Error(`missing exported source inventory ${name}`);
}

function coverageEnvironments(path: string): string[] {
  const environments = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (
      ts.isPropertyAssignment(node) &&
      ((ts.isIdentifier(node.name) && node.name.text === "environment") ||
        (ts.isStringLiteralLike(node.name) &&
          node.name.text === "environment")) &&
      ts.isStringLiteralLike(node.initializer)
    ) {
      environments.add(node.initializer.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceAst(path));
  return [...environments].sort();
}

describe("provider mock catalog", () => {
  test("maps every production-derived provider, model, and connector registration", () => {
    const inventory = buildRuntimeSurfaceInventory({
      generatedAt: "2030-01-01T00:00:00.000Z",
      sourceRevision: "provider-catalog-test",
    });
    expect(inventory.schema).toBe(RUNTIME_SURFACE_SCHEMA);
    const boundaryRows = inventory.rows.filter((row) =>
      [
        "provider",
        "model-handler",
        "connector-ingress",
        "connector-egress",
      ].includes(row.kind),
    );
    const productionPackages = [
      ...new Set(boundaryRows.map((row) => row.packageName)),
    ].sort();
    expect(Object.keys(catalog.runtimeSurfaceOwners).sort()).toEqual(
      productionPackages,
    );
    const catalogIds = new Set(catalog.entries.map((entry) => entry.id));
    for (const row of boundaryRows) {
      const owner = catalog.runtimeSurfaceOwners[row.packageName];
      expect(
        owner,
        `unowned production runtime surface ${row.id}`,
      ).toBeDefined();
      expect(catalogIds.has(owner), `${row.id} -> ${owner}`).toBe(true);
    }
    expect(
      boundaryRows.filter((row) => row.mockAvailability !== "available").length,
    ).toBeGreaterThan(0);
  }, 60_000);

  test("derives complete ownership from maintained in-process and Mockoon roots", () => {
    const catalogIds = new Set(catalog.entries.map((entry) => entry.id));
    const maintainedEnvironments = exportedStringArray(
      "packages/scenario-runner/test/mocks/scripts/start-mocks.ts",
      "MOCK_PROVIDER_ENVIRONMENTS",
    );
    expect(Object.keys(catalog.environmentOwners).sort()).toEqual(
      maintainedEnvironments.sort(),
    );
    const mockoonEnvironments = readdirSync(
      resolve(repoRoot, "packages/scenario-runner/test/mocks/mockoon"),
    )
      .filter((name) => name.endsWith(".json"))
      .map((name) => name.slice(0, -5))
      .sort();
    expect(Object.keys(catalog.mockoonOwners).sort()).toEqual(
      mockoonEnvironments,
    );
    for (const [environment, owner] of Object.entries({
      ...catalog.environmentOwners,
      ...catalog.mockoonOwners,
    })) {
      expect(catalogIds.has(owner), `${environment} -> ${owner}`).toBe(true);
    }
    for (const environment of coverageEnvironments(
      "packages/scenario-runner/test/mocks/helpers/provider-coverage.ts",
    )) {
      expect(
        catalog.environmentOwners[environment],
        `unowned production coverage environment ${environment}`,
      ).toBeDefined();
    }
  });

  test("requires protocol, fidelity, control, scenario, canary, and source metadata", () => {
    expect(catalog.schemaVersion).toBe(1);
    expect(catalog.controlContract).toBe("provider-mock-control-v1");
    expect(catalog.certificationPolicy).toContain("never provider-qualified");
    const ids = new Set<string>();
    for (const entry of catalog.entries) {
      expect(ids.has(entry.id), `duplicate ${entry.id}`).toBe(false);
      ids.add(entry.id);
      expect(
        entry.productionClients.length,
        `${entry.id} clients`,
      ).toBeGreaterThan(0);
      expect(entry.apiVersions.length, `${entry.id} versions`).toBeGreaterThan(
        0,
      );
      expect(entry.endpoints.length, `${entry.id} endpoints`).toBeGreaterThan(
        0,
      );
      expect(entry.fidelity.trim(), `${entry.id} fidelity`).not.toBe("");
      expect(entry.control.trim(), `${entry.id} control`).not.toBe("");
      expect(entry.scenarios.length, `${entry.id} scenarios`).toBeGreaterThan(
        0,
      );
      expect(entry.canary.trim(), `${entry.id} canary`).not.toBe("");
      expect(entry.certification).toBe("mock-only");
      expect(
        existsSync(resolve(repoRoot, entry.mockSource)),
        `${entry.id} missing ${entry.mockSource}`,
      ).toBe(true);
      const evidence = catalog.contractEvidence[entry.id];
      expect(
        evidence?.length,
        `${entry.id} executable evidence`,
      ).toBeGreaterThan(0);
      for (const binding of evidence ?? []) {
        const [path, suiteId] = binding.split("#");
        const source = readFileSync(resolve(repoRoot, path), "utf8");
        expect(source, `${entry.id} missing suite ${suiteId}`).toContain(
          suiteId,
        );
      }
    }
    expect(Object.keys(catalog.contractEvidence).sort()).toEqual(
      [...ids].sort(),
    );
  });

  test("keeps messaging and webhook expansion explicitly outside this shard", () => {
    expect(
      catalog.entries.find((entry) => entry.id === "messaging-webhook-family"),
    ).toMatchObject({
      ownerShard: "reserved-later-messaging-webhook-shard",
      certification: "mock-only",
    });
  });
});
