/**
 * Repository contract: the retired third-party backend may be studied only in
 * explicitly isolated research material. It is not a shipped runtime, backend,
 * setting, installer, compatibility shim, or product surface. Eliza Code owns
 * the coding-agent path.
 *
 * Deterministic and local-only: the test scans tracked text files and performs no
 * network or provider calls.
 */

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TEST_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(TEST_DIRECTORY, "..", "..", "..");
const RETIRED_BACKEND_PATTERN = /(?:\bopencode|\bopen[-_\s]+code\b)/i;
const RETIRED_AGENT_FILE_STEM = ["Open", "Code", "Agent"].join("");

const RESEARCH_PREFIXES = [
  "packages/benchmarks/skillsbench/docs/skills-research/",
  "packages/benchmarks/skillsbench/skills/artifacts/",
  "packages/training/data/",
  "plugins/plugin-agent-orchestrator/docs/research/",
];
const REMOVAL_PROVENANCE_PREFIXES = ["patches/"];

const TEXT_FILE_PATTERN =
  /(?:\.(?:cjs|css|html|js|json|jsx|md|mjs|mts|py|sh|swift|toml|ts|tsx|txt|yaml|yml)|(?:^|\/)Dockerfile|(?:^|\/)AGENTS\.md|(?:^|\/)CLAUDE\.md)$/i;
const ROOT_TEXT_FILES = new Set([".env.example", ".gitmodules"]);

function trackedTextFiles(): string[] {
  const result = spawnSync("git", ["ls-files", "-z"], {
    cwd: REPOSITORY_ROOT,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || "git ls-files failed");
  }
  return result.stdout
    .split("\0")
    .filter(Boolean)
    .filter((file) => existsSync(path.join(REPOSITORY_ROOT, file)))
    .filter((file) => !file.endsWith("CHANGELOG.md"))
    .filter(
      (file) =>
        !REMOVAL_PROVENANCE_PREFIXES.some((prefix) => file.startsWith(prefix)),
    )
    .filter(
      (file) => !RESEARCH_PREFIXES.some((prefix) => file.startsWith(prefix)),
    )
    .filter(
      (file) =>
        ROOT_TEXT_FILES.has(file) ||
        TEXT_FILE_PATTERN.test(file) ||
        file.startsWith("plugins/plugin-agent-orchestrator/bin/"),
    );
}

function packageRoot(entrypoint: string): string {
  let current = path.dirname(realpathSync(entrypoint));
  for (;;) {
    if (existsSync(path.join(current, "package.json"))) return current;
    const parent = path.dirname(current);
    if (parent === current)
      throw new Error(`package root not found for ${entrypoint}`);
    current = parent;
  }
}

function installedSmithersRoots(): {
  agentsRoot: string;
  engineRoot: string;
  smithersRoot: string;
} {
  const orchestratorRequire = createRequire(
    path.join(
      REPOSITORY_ROOT,
      "plugins",
      "plugin-agent-orchestrator",
      "package.json",
    ),
  );
  const smithersRoot = packageRoot(orchestratorRequire.resolve("smthrs"));
  const smithersRequire = createRequire(
    path.join(smithersRoot, "package.json"),
  );
  const agentsRoot = packageRoot(smithersRequire.resolve("@smthrs/agents"));
  const engineRoot = packageRoot(smithersRequire.resolve("@smthrs/engine"));
  return { agentsRoot, engineRoot, smithersRoot };
}

function installedSmithersTextFiles(): string[] {
  const roots = Object.values(installedSmithersRoots());
  const files: string[] = [];
  for (const root of roots) {
    if (!existsSync(root)) {
      throw new Error(`required patched dependency is not installed: ${root}`);
    }
    const visit = (entry: string): void => {
      const info = statSync(entry);
      if (info.isDirectory()) {
        for (const child of readdirSync(entry)) visit(path.join(entry, child));
        return;
      }
      if (info.isFile() && TEXT_FILE_PATTERN.test(entry)) files.push(entry);
    };
    visit(root);
  }
  return files;
}

describe("Eliza Code is the exclusive shipped coding backend", () => {
  test("contains no retired backend product surface outside isolated research", () => {
    const violations = trackedTextFiles().filter((file) => {
      const source = readFileSync(path.join(REPOSITORY_ROOT, file), "utf8");
      const withoutBackdropCodecNames = source
        .replaceAll(/backdropencoded/giu, "")
        .replaceAll(/backdropencoder/giu, "");
      return RETIRED_BACKEND_PATTERN.test(withoutBackdropCodecNames);
    });

    expect(violations).toEqual([]);
  }, 15_000);

  test("strips the retired backend from the installed Smithers dependency closure", () => {
    const { agentsRoot, smithersRoot } = installedSmithersRoots();
    const violations = installedSmithersTextFiles().filter((file) =>
      RETIRED_BACKEND_PATTERN.test(readFileSync(file, "utf8")),
    );

    expect(violations).toEqual([]);
    expect(
      existsSync(path.join(agentsRoot, "src", `${RETIRED_AGENT_FILE_STEM}.js`)),
    ).toBe(false);
    expect(
      existsSync(
        path.join(agentsRoot, "src", `${RETIRED_AGENT_FILE_STEM}Options.ts`),
      ),
    ).toBe(false);
    const smithersManifest = JSON.parse(
      readFileSync(path.join(smithersRoot, "package.json"), "utf8"),
    ) as { bin?: unknown; dependencies?: Record<string, string> };
    expect(smithersManifest.bin).toBeUndefined();
    expect(smithersManifest.dependencies?.["@smthrs/cli"]).toBeUndefined();
    expect(
      existsSync(path.join(smithersRoot, "src", "bin", "smithers.js")),
    ).toBe(false);
    const agentsRequire = createRequire(path.join(agentsRoot, "package.json"));
    expect(() =>
      agentsRequire.resolve(`@smthrs/agents/${RETIRED_AGENT_FILE_STEM}`),
    ).toThrow();
    expect(() =>
      agentsRequire.resolve(`@smthrs/agents/${RETIRED_AGENT_FILE_STEM}.js`),
    ).toThrow();
  });
});
