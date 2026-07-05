// Pins the CI Bun-version contract (#13402) against synthetic repo trees: a
// clean tree with every gate pinned to the canonical version passes (and a
// `canary` named only in a comment is ignored), while a divergent concrete pin,
// a gate floated back to `canary`, a gate missing the pin, and a floating source
// of truth each fail. Also runs the shipped contract against the real repo so
// the guard stays true as workflows change. Deterministic — no workflow runs.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const { runContract } = await import(
  new URL("../ci-bun-version-contract.mjs", import.meta.url).href
);

const REAL_REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));

const CANONICAL = "1.3.14";

const GATE_WORKFLOWS = [
  "ci.yaml",
  "test.yml",
  "develop-exhaustive.yml",
  "ci-full-matrix-proof.yml",
  "benchmark-tests.yml",
  "windows-desktop-preload-smoke.yml",
  "feed-env-audit.yml",
];

// A gate stub that pins via a BUN_VERSION env literal and references it from the
// step by expression — the shape the real gates use. The comment naming
// `canary` proves the contract reads YAML wiring, not prose.
function gateStub(version = CANONICAL): string {
  return `name: Gate
on: [push]
env:
  # pinned: floating canary writes lockfileVersion 2 and breaks --frozen-lockfile
  BUN_VERSION: "${version}"
jobs:
  build:
    runs-on: ubuntu-24.04
    steps:
      - uses: ./.github/actions/setup-bun-workspace
        with:
          bun-version: \${{ env.BUN_VERSION }}
`;
}

const GATE_FLOATING = `name: Gate
on: [push]
jobs:
  build:
    runs-on: ubuntu-24.04
    steps:
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: canary
`;

const GATE_NO_PIN = `name: Gate
on: [push]
jobs:
  build:
    runs-on: ubuntu-24.04
    steps:
      - run: echo "no bun setup here"
`;

// A non-gate workflow carrying a concrete pin that diverges from canonical.
function driftWorkflow(version: string): string {
  return `name: Drift
on: [push]
jobs:
  build:
    runs-on: ubuntu-24.04
    steps:
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: "${version}"
`;
}

function buildRepo({
  version = CANONICAL,
  overrides = {},
  extra = {},
}: {
  version?: string;
  overrides?: Record<string, string>;
  extra?: Record<string, string>;
}): string {
  const root = mkdtempSync(join(tmpdir(), "ci-bun-version-contract-"));
  mkdirSync(join(root, ".github", "workflows"), { recursive: true });
  writeFileSync(
    join(root, ".github", "ci-bun-version.json"),
    JSON.stringify({ version }),
  );
  for (const name of GATE_WORKFLOWS) {
    writeFileSync(
      join(root, ".github", "workflows", name),
      overrides[name] ?? gateStub(),
    );
  }
  for (const [name, content] of Object.entries(extra)) {
    writeFileSync(join(root, ".github", "workflows", name), content);
  }
  return root;
}

describe("ci-bun-version-contract", () => {
  test("passes a clean tree with every gate pinned to canonical", () => {
    const root = buildRepo({});
    try {
      const { canonical, gateWorkflows } = runContract(root);
      expect(canonical).toBe(CANONICAL);
      expect(gateWorkflows).toEqual(GATE_WORKFLOWS);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("fails when a concrete pin diverges from the source of truth", () => {
    const root = buildRepo({ extra: { "drift.yml": driftWorkflow("1.3.99") } });
    try {
      expect(() => runContract(root)).toThrow(
        /canonical CI Bun version is 1\.3\.14/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("fails when a gate workflow floats back to canary", () => {
    const root = buildRepo({ overrides: { "test.yml": GATE_FLOATING } });
    try {
      expect(() => runContract(root)).toThrow(/wires floating Bun/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("fails when a gate workflow drops the canonical pin entirely", () => {
    const root = buildRepo({ overrides: { "ci.yaml": GATE_NO_PIN } });
    try {
      expect(() => runContract(root)).toThrow(
        /does not wire the canonical Bun pin/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("fails when the source of truth itself floats", () => {
    const root = buildRepo({ version: "canary" });
    try {
      expect(() => runContract(root)).toThrow(/must be a concrete Bun pin/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("the real repo satisfies the contract", () => {
    const { canonical, gateWorkflows } = runContract(REAL_REPO_ROOT);
    expect(canonical).toBe(CANONICAL);
    expect(gateWorkflows.length).toBeGreaterThan(0);
  });
});
