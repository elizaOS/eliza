/** Protects the solvable Argos Translate dependency boundary across the training manifest, lockfile, and Dependabot. */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

interface DependabotUpdate {
  "package-ecosystem"?: string;
  directory?: string;
  ignore?: Array<{ "dependency-name"?: string }>;
}

const read = (relativePath: string) =>
  readFileSync(new URL(relativePath, import.meta.url), "utf8");

const pyproject = Bun.TOML.parse(read("../../training/pyproject.toml")) as {
  project?: { dependencies?: string[] };
};
const lock = read("../../training/uv.lock");
const dependabot = Bun.YAML.parse(read("../../../.github/dependabot.yml")) as {
  updates?: DependabotUpdate[];
};

const trainingDependabot = dependabot.updates?.find(
  (candidate) =>
    candidate["package-ecosystem"] === "pip" &&
    candidate.directory === "/packages/training",
);

describe("training Python dependency contract", () => {
  test("keeps the manifest and lockfile on Argos Translate's exact Stanza release", () => {
    expect(pyproject.project?.dependencies).toContain("argostranslate>=1.11.0");
    expect(pyproject.project?.dependencies).toContain("stanza==1.10.1");
    expect(lock).toMatch(
      /\[\[package\]\]\nname = "stanza"\nversion = "1\.10\.1"/,
    );
    expect(lock).toContain(`{ name = "stanza", specifier = "==1.10.1" }`);
  });

  test("prevents Dependabot from proposing the unsatisfiable Stanza upgrade", () => {
    expect(trainingDependabot).toBeDefined();
    expect(trainingDependabot?.ignore).toContainEqual({
      "dependency-name": "stanza",
    });
  });
});
