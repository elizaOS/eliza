/**
 * Keeps the repository's workflow and composite-action graph immutable,
 * uniquely named, and referenced.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const githubRoot = join(repoRoot, ".github");

function collectYamlFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return collectYamlFiles(path);
    return /\.ya?ml$/u.test(entry.name) ? [path] : [];
  });
}

describe("GitHub action supply-chain references", () => {
  test("pins every external action and reusable workflow to a commit SHA", () => {
    const mutableReferences: string[] = [];

    for (const file of collectYamlFiles(githubRoot)) {
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(/^\s*(?:-\s*)?uses:\s+(\S+)\s*$/gmu)) {
        const reference = match[1];
        if (reference.startsWith("./") || reference.startsWith("docker://")) {
          continue;
        }
        if (!/^[^@\s]+@[0-9a-f]{40}$/u.test(reference)) {
          mutableReferences.push(`${relative(repoRoot, file)} -> ${reference}`);
        }
      }
    }

    expect(mutableReferences).toEqual([]);
  });

  test("keeps workflow display names unique", () => {
    const names = new Map<string, string[]>();
    for (const file of collectYamlFiles(join(githubRoot, "workflows"))) {
      const workflow = Bun.YAML.parse(readFileSync(file, "utf8")) as {
        name?: string;
      };
      const name = workflow.name ?? "";
      names.set(name, [...(names.get(name) ?? []), relative(repoRoot, file)]);
    }

    expect(
      [...names.entries()].filter(([name, files]) => !name || files.length > 1),
    ).toEqual([]);
  });

  test("does not retain orphaned local composite actions", () => {
    const yamlFiles = collectYamlFiles(githubRoot);
    const graph = yamlFiles.map((file) => readFileSync(file, "utf8")).join("\n");
    const orphaned = yamlFiles
      .filter((file) => /^action\.ya?ml$/u.test(file.split("/").at(-1) ?? ""))
      .map((file) => `./${relative(repoRoot, dirname(file))}`)
      .filter((reference) => !graph.includes(`uses: ${reference}`));

    expect(orphaned).toEqual([]);
  });

});
