/** Tests the production soak factory boundary without shortening or fabricating a soak run. */

import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  CONTENT_CONTEXT_SOAK_FACTORY_SCHEMA_VERSION,
  parseSoakArgs,
  produceContentContextSoak,
  validateSoakFactoryModule,
} from "../run-content-context-soak.mjs";

const families = [
  "file",
  "document",
  "memory",
  "email",
  "attachment",
  "tool-output",
] as const;

function contract(selected: readonly string[] = families) {
  const realizations = {
    file: ["filesystem", "native-bytes"],
    document: ["document-store", "typed-rejection"],
    memory: ["memory-store", "typed-rejection"],
    email: ["message-store", "typed-rejection"],
    attachment: ["content-addressed-media", "native-bytes"],
    "tool-output": ["filesystem", "native-bytes"],
  };
  return {
    schemaVersion: CONTENT_CONTEXT_SOAK_FACTORY_SCHEMA_VERSION,
    production: true,
    targets: selected.map((family, index) => ({
      family,
      adapterId: `production-adapter-${index}`,
      authoritativeStore: realizations[family]?.[0],
      binaryPolicy: realizations[family]?.[1],
      productionMethod: `${family}-native-realization`,
      create: async () => ({}),
    })),
    measureResources: async () => ({}),
  };
}

describe("content-context soak producer", () => {
  it("requires every execution input", () => {
    expect(() => parseSoakArgs([])).toThrow(/factory-module is required/u);
    expect(
      parseSoakArgs([
        "--factory-module=/private/factories.mjs",
        "--corpus-manifest=/private/manifest.json",
        "--out=/private/soak.json",
        `--commit=${"a".repeat(40)}`,
      ]),
    ).toMatchObject({ out: "/private/soak.json" });
  });

  it("fails with a typed error when the operator production module is absent", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "content-soak-missing-"),
    );
    try {
      const manifest = path.join(root, "manifest.json");
      await fs.writeFile(
        manifest,
        `${JSON.stringify({ manifestSha256: "b".repeat(64) })}\n`,
        { mode: 0o600 },
      );
      await expect(
        produceContentContextSoak({
          factoryModule: path.join(root, "missing-production-factories.mjs"),
          corpusManifest: manifest,
          out: path.join(root, "soak.json"),
          commit: "a".repeat(40),
        }),
      ).rejects.toMatchObject({ code: "SOAK_INPUT_UNAVAILABLE" });
      await expect(fs.stat(path.join(root, "soak.json"))).rejects.toMatchObject(
        {
          code: "ENOENT",
        },
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("accepts only exact six-family production contracts", () => {
    expect(validateSoakFactoryModule(contract()).targets).toHaveLength(6);
    for (const invalid of [
      contract([]),
      contract(families.slice(0, 5)),
      contract([...families.slice(0, 5), "file"]),
    ])
      expect(() => validateSoakFactoryModule(invalid)).toThrow(
        /exact families|each required family/u,
      );
  });

  it("rejects fixture-shaped and duplicate adapter declarations", () => {
    const fixture = contract();
    fixture.targets[0].adapterId = "file-fixture-adapter";
    expect(() => validateSoakFactoryModule(fixture)).toThrow(/non-fixture/u);

    const duplicate = contract();
    duplicate.targets[1].adapterId = duplicate.targets[0].adapterId;
    expect(() => validateSoakFactoryModule(duplicate)).toThrow(/unique/u);

    const sqlBinary = contract();
    sqlBinary.targets[0].authoritativeStore = "document-store";
    sqlBinary.targets[0].binaryPolicy = "typed-rejection";
    expect(() => validateSoakFactoryModule(sqlBinary)).toThrow(
      /exact families/u,
    );
  });
});
