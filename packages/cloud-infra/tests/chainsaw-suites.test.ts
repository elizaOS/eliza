/**
 * Static checks for the Chainsaw suites under `cloud/tests/0*`.
 *
 * These do not replace kind/Chainsaw execution. They catch malformed YAML and
 * stale local file references before a cluster is involved.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { parseAllDocuments } from "yaml";

const TESTS_DIR = join(import.meta.dir, "..", "cloud", "tests");

interface ChainsawStep {
  name?: string;
  try?: Array<{ apply?: { file?: string }; assert?: { file?: string } }>;
  cleanup?: Array<{ apply?: { file?: string }; assert?: { file?: string } }>;
  catch?: Array<{ apply?: { file?: string }; assert?: { file?: string } }>;
}

interface ChainsawTestDoc {
  apiVersion: string;
  kind: string;
  metadata: { name: string };
  spec: {
    steps: ChainsawStep[];
  };
}

function walkYamlFiles(dir: string): string[] {
  return readdirSync(dir)
    .flatMap((entry) => {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) return walkYamlFiles(path);
      return path.endsWith(".yaml") ? [path] : [];
    })
    .sort();
}

function loadYamlDocs(file: string): unknown[] {
  const raw = readFileSync(file, "utf-8");
  return parseAllDocuments(raw).map((doc) => doc.toJSON());
}

function collectReferencedFiles(step: ChainsawStep): string[] {
  const actions = [
    ...(step.try ?? []),
    ...(step.cleanup ?? []),
    ...(step.catch ?? []),
  ];
  return actions
    .flatMap((action) => [action.apply?.file, action.assert?.file])
    .filter(
      (file): file is string => typeof file === "string" && file.length > 0,
    );
}

describe("Chainsaw suite YAML", () => {
  const yamlFiles = walkYamlFiles(TESTS_DIR);
  const suiteFiles = yamlFiles.filter(
    (file) => basename(file) === "chainsaw-test.yaml",
  );

  test("parses every YAML file under cloud/tests", () => {
    expect(yamlFiles.length).toBeGreaterThan(0);

    for (const file of yamlFiles) {
      const docs = loadYamlDocs(file);
      expect(docs.length, relative(TESTS_DIR, file)).toBeGreaterThan(0);
      for (const doc of docs) {
        expect(doc, relative(TESTS_DIR, file)).not.toBeNull();
      }
    }
  });

  test("declares every suite as a named Chainsaw Test with steps", () => {
    expect(suiteFiles.length).toBeGreaterThan(0);

    for (const file of suiteFiles) {
      const [doc] = loadYamlDocs(file) as [ChainsawTestDoc];
      expect(doc.apiVersion, relative(TESTS_DIR, file)).toMatch(
        /^chainsaw\.kyverno\.io\//,
      );
      expect(doc.kind, relative(TESTS_DIR, file)).toBe("Test");
      expect(typeof doc.metadata.name, relative(TESTS_DIR, file)).toBe(
        "string",
      );
      expect(
        doc.metadata.name.length,
        relative(TESTS_DIR, file),
      ).toBeGreaterThan(0);
      expect(Array.isArray(doc.spec.steps), relative(TESTS_DIR, file)).toBe(
        true,
      );
      expect(doc.spec.steps.length, relative(TESTS_DIR, file)).toBeGreaterThan(
        0,
      );
    }
  });

  test("all local apply/assert file references exist beside their suite", () => {
    for (const file of suiteFiles) {
      const [doc] = loadYamlDocs(file) as [ChainsawTestDoc];
      const suiteDir = join(file, "..");

      for (const step of doc.spec.steps) {
        for (const referenced of collectReferencedFiles(step)) {
          expect(
            existsSync(join(suiteDir, referenced)),
            `${relative(TESTS_DIR, file)} step "${step.name ?? "(unnamed)"}" references ${referenced}`,
          ).toBe(true);
        }
      }
    }
  });
});
