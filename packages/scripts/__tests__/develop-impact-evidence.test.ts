/** Exercises exact-input surface invalidation and fail-closed evidence reuse without network or GitHub state. */

import { describe, expect, test } from "bun:test";
import {
  computeExpectedManifest,
  createEvidence,
  resolveEvidenceRuns,
  sha256,
  validateGraph,
  verifyCompleteManifest,
  verifyEvidence,
} from "../develop-impact-evidence.mjs";

const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const NOW = new Date("2026-08-21T12:00:00.000Z");

function graph() {
  return {
    schemaVersion: 1,
    graphVersion: "fixture-v1",
    evidenceTtlHours: 24,
    reusePolicy: "exact-environment",
    environment: { bun: "1.3.14", node: "24.15.0", runner: "fixture" },
    globalInputs: ["toolchain.json", "graph.json"],
    knownNonValidationInputs: [],
    surfaces: [
      {
        id: "leaf",
        workflow: "leaf.yml",
        workspacePatterns: ["packages/leaf"],
        inputs: [
          "*.md",
          "**/*.md",
          "packages/docs/**",
          "contracts/leaf.json",
          "fixtures/leaf.json",
        ],
      },
      {
        id: "consumer",
        workflow: "consumer.yml",
        workspacePatterns: ["packages/consumer"],
        inputs: ["contracts/consumer.json"],
        dependsOn: ["leaf"],
      },
    ],
  };
}

function tracked(overrides: Record<string, string> = {}) {
  const contents = {
    "toolchain.json": "toolchain-v1",
    "graph.json": "graph-v1",
    "leaf.yml": "jobs:\n  test:\n    steps: []\n",
    "consumer.yml": "jobs:\n  test:\n    steps: []\n",
    "packages/shared/package.json": "shared-manifest",
    "packages/shared/src.ts": "shared-source",
    "packages/leaf/package.json": "leaf-manifest",
    "packages/leaf/src.ts": "leaf-source",
    "packages/consumer/package.json": "consumer-manifest",
    "packages/consumer/src.ts": "consumer-source",
    "contracts/leaf.json": "leaf-contract",
    "contracts/consumer.json": "consumer-contract",
    "fixtures/leaf.json": "leaf-fixture",
    "README.md": "root-readme",
    "CLAUDE.md": "root-guide",
    "docs/readme.md": "documentation",
    "packages/docs/guide.md": "maintained-docs",
    ...overrides,
  };
  return new Map(
    Object.entries(contents).map(([path, content]) => [
      path,
      { content, contentDigest: sha256(content), mode: "100644" },
    ]),
  );
}

function workspaces() {
  const entries = [
    {
      dependencies: new Set<string>(),
      directory: "packages/shared",
      name: "@fixture/shared",
    },
    {
      dependencies: new Set(["@fixture/shared"]),
      directory: "packages/leaf",
      name: "@fixture/leaf",
    },
    {
      dependencies: new Set(["@fixture/leaf"]),
      directory: "packages/consumer",
      name: "@fixture/consumer",
    },
  ];
  return {
    byDirectory: new Map(entries.map((entry) => [entry.directory, entry])),
    byName: new Map(entries.map((entry) => [entry.name, entry])),
  };
}

function manifest(
  changedPaths: string[],
  options: {
    graph?: ReturnType<typeof graph>;
    tracked?: ReturnType<typeof tracked>;
    baseSha?: string;
  } = {},
) {
  return computeExpectedManifest({
    baseSha: options.baseSha ?? BASE,
    changedPaths,
    graph: options.graph ?? graph(),
    headSha: HEAD,
    tracked: options.tracked ?? tracked(),
    workspaces: workspaces(),
  });
}

function evidenceRows(expected: ReturnType<typeof manifest>) {
  return expected.surfaces.map((surface) =>
    createEvidence(expected, surface.id, NOW, 24),
  );
}

function digest(expected: ReturnType<typeof manifest>, id: string) {
  const value = expected.surfaces.find(
    (surface) => surface.id === id,
  )?.inputDigest;
  if (!value) throw new Error(`missing fixture surface ${id}`);
  return value;
}

describe("Develop Full impact graph", () => {
  test("binds a leaf to its complete transitive workspace input closure", () => {
    const expected = manifest(["packages/leaf/src.ts"]);
    const leaf = expected.surfaces.find((surface) => surface.id === "leaf");
    expect(leaf?.workspaceClosure).toEqual([
      "@fixture/leaf",
      "@fixture/shared",
    ]);
    expect(leaf?.inputCount).toBeGreaterThan(2);
    expect(leaf?.inputInventoryDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(leaf?.invalidated).toBe(true);
    expect(
      expected.surfaces.find((surface) => surface.id === "consumer")
        ?.invalidated,
    ).toBe(true);
  });

  test("shared dependency mutation invalidates every transitive consumer", () => {
    const expected = manifest(["packages/shared/src.ts"]);
    expect(
      expected.surfaces.map(({ id, invalidated }) => [id, invalidated]),
    ).toEqual([
      ["consumer", true],
      ["leaf", true],
    ]);
  });

  test("a deleted workspace input still invalidates its owner and dependents", () => {
    const afterDeletion = tracked();
    afterDeletion.delete("packages/leaf/src.ts");
    const expected = manifest(["packages/leaf/src.ts"], {
      tracked: afterDeletion,
    });
    expect(expected.unknownPaths).toEqual([]);
    expect(expected.surfaces.every((surface) => surface.invalidated)).toBe(
      true,
    );
  });

  test.each([
    ["contract", "contracts/leaf.json"],
    ["fixture", "fixtures/leaf.json"],
  ])(
    "%s mutation invalidates the owning surface and dependent",
    (_kind, path) => {
      const expected = manifest([path]);
      expect(expected.surfaces.every((surface) => surface.invalidated)).toBe(
        true,
      );
    },
  );

  test("toolchain mutation invalidates every surface", () => {
    expect(
      manifest(["toolchain.json"]).surfaces.every(
        (surface) => surface.invalidated,
      ),
    ).toBe(true);
  });

  test("documentation invalidates owned evidence while unknown paths force all work", () => {
    const docs = manifest(["docs/readme.md"]);
    expect(docs.unknownPaths).toEqual([]);
    expect(docs.surfaces.every((surface) => surface.invalidated)).toBe(true);
    expect(docs.surfaces.every((surface) => !surface.forceRun)).toBe(true);

    const unknown = manifest(["unowned/source.ts"]);
    expect(unknown.unknownPaths).toEqual(["unowned/source.ts"]);
    expect(
      unknown.surfaces.every(
        (surface) => surface.invalidated && surface.forceRun,
      ),
    ).toBe(true);

    const executableSite = manifest(["packages/os-homepage/src/index.ts"]);
    expect(executableSite.unknownPaths).toEqual([
      "packages/os-homepage/src/index.ts",
    ]);
    expect(executableSite.surfaces.every((surface) => surface.forceRun)).toBe(
      true,
    );
  });

  test.each(["README.md", "CLAUDE.md", "packages/docs/guide.md"])(
    "%s cannot reuse all prior validation evidence",
    (changedPath) => {
      const baseline = manifest([]);
      const candidate = manifest([changedPath], {
        tracked: tracked({ [changedPath]: "changed-markdown" }),
      });
      const runs = resolveEvidenceRuns(candidate, evidenceRows(baseline), NOW);
      expect(runs.leaf).toBe(true);
      expect(Object.values(runs).some(Boolean)).toBe(true);
    },
  );

  test("a catch-all audit surface cannot disguise unknown ownership", () => {
    const catchAllGraph = graph();
    catchAllGraph.surfaces.push({
      id: "audit",
      workflow: "audit.yml",
      workspacePatterns: [],
      inputs: ["**"],
      catchAll: true,
    });
    const inputs = tracked({
      "audit.yml": "jobs:\n  test:\n    steps: []\n",
    });
    const expected = manifest(["unowned/source.ts"], {
      graph: catchAllGraph,
      tracked: inputs,
    });
    expect(expected.unknownPaths).toEqual(["unowned/source.ts"]);
    expect(expected.surfaces.every((surface) => surface.forceRun)).toBe(true);
  });

  test("an all-zero base forces the full seed", () => {
    const expected = manifest([], { baseSha: "0".repeat(40) });
    expect(expected.surfaces.every((surface) => surface.forceRun)).toBe(true);
  });

  test("file bytes, environment, and graph version independently change digests", () => {
    const baseline = manifest([]);
    const bytes = manifest([], {
      tracked: tracked({ "packages/shared/src.ts": "changed" }),
    });
    const environmentGraph = graph();
    environmentGraph.environment.runner = "different";
    const environment = manifest([], { graph: environmentGraph });
    const versionGraph = graph();
    versionGraph.graphVersion = "fixture-v2";
    const version = manifest([], { graph: versionGraph });
    for (const candidate of [bytes, environment, version]) {
      expect(digest(candidate, "leaf")).not.toBe(digest(baseline, "leaf"));
      expect(digest(candidate, "consumer")).not.toBe(
        digest(baseline, "consumer"),
      );
    }
  });

  test("hashes transitive local workflows and complete composite action directories", () => {
    const dependencyGraph = graph();
    dependencyGraph.surfaces[1].dependsOn = [];
    const localDependencies = {
      "leaf.yml":
        "jobs:\n  test:\n    uses: ./.github/workflows/reusable.yml\n",
      "consumer.yml":
        "jobs:\n  test:\n    uses: ./.github/workflows/reusable.yml\n",
      ".github/workflows/reusable.yml":
        "jobs:\n  delegated:\n    steps:\n      - uses: ./.github/actions/setup\n",
      ".github/actions/setup/action.yml":
        "runs:\n  using: composite\n  steps:\n    - uses: ./.github/actions/nested\n",
      ".github/actions/setup/run.mjs": "setup-v1",
      ".github/actions/nested/action.yaml":
        "runs:\n  using: composite\n  steps: []\n",
    };
    const baseline = manifest([], {
      graph: dependencyGraph,
      tracked: tracked({
        ...localDependencies,
        ".github/actions/nested/run.mjs": "nested-v1",
      }),
    });
    const changed = manifest([".github/actions/nested/run.mjs"], {
      graph: dependencyGraph,
      tracked: tracked({
        ...localDependencies,
        ".github/actions/nested/run.mjs": "nested-v2",
      }),
    });
    expect(digest(changed, "leaf")).not.toBe(digest(baseline, "leaf"));
    expect(digest(changed, "consumer")).not.toBe(digest(baseline, "consumer"));
    expect(changed.unknownPaths).toEqual([]);
  });

  test("fails closed for missing, invalid, and cyclic local uses targets", () => {
    const missing = tracked({
      "leaf.yml": "jobs:\n  test:\n    uses: ./.github/workflows/missing.yml\n",
    });
    expect(() => manifest([], { tracked: missing })).toThrow(
      /missing local target/,
    );

    const invalid = tracked({
      "leaf.yml": "jobs:\n  test:\n    uses: ./outside.yml\n",
      "outside.yml": "jobs: {}\n",
    });
    expect(() => manifest([], { tracked: invalid })).toThrow(
      /outside .github\/workflows/,
    );

    const cyclic = tracked({
      "leaf.yml": "jobs:\n  test:\n    uses: ./.github/workflows/first.yml\n",
      ".github/workflows/first.yml":
        "jobs:\n  test:\n    uses: ./.github/workflows/second.yml\n",
      ".github/workflows/second.yml":
        "jobs:\n  test:\n    uses: ./.github/workflows/first.yml\n",
    });
    expect(() => manifest([], { tracked: cyclic })).toThrow(/dependency cycle/);
  });

  test("binds persistently unowned inputs into every immutable cache key", () => {
    const baseline = manifest([], {
      tracked: tracked({ "unowned/executable.sh": "v1" }),
    });
    const changed = manifest(["unowned/executable.sh"], {
      tracked: tracked({ "unowned/executable.sh": "v2" }),
    });
    expect(changed.unknownPaths).toEqual(["unowned/executable.sh"]);
    expect(digest(changed, "leaf")).not.toBe(digest(baseline, "leaf"));
    expect(digest(changed, "consumer")).not.toBe(digest(baseline, "consumer"));
  });

  test("current-run-only policy refuses cross-run evidence reuse", () => {
    const policyGraph = graph();
    policyGraph.reusePolicy = "current-run-only";
    const expected = manifest([], { graph: policyGraph });
    expect(resolveEvidenceRuns(expected, evidenceRows(expected), NOW)).toEqual({
      consumer: true,
      leaf: true,
    });
  });

  test("rejects duplicate, cyclic, missing, and zero-work graph definitions", () => {
    const duplicate = graph();
    duplicate.surfaces.push({ ...duplicate.surfaces[0] });
    expect(() => validateGraph(duplicate)).toThrow(/duplicate surface/);

    const cyclic = graph();
    cyclic.surfaces[0].dependsOn = ["consumer"];
    expect(() => validateGraph(cyclic)).toThrow(/cycle/);

    const missing = graph();
    missing.surfaces[1].dependsOn = ["absent"];
    expect(() => validateGraph(missing)).toThrow(/unknown dependency/);

    const empty = graph();
    empty.surfaces = [];
    expect(() => validateGraph(empty)).toThrow(/at least one surface/);
  });
});

describe("Develop Full evidence verification", () => {
  test("accepts one current cryptographically matching row per expected surface", () => {
    const expected = manifest([]);
    const observed = verifyCompleteManifest(
      expected,
      evidenceRows(expected),
      NOW,
    );
    expect(observed.headSha).toBe(HEAD);
    expect(observed.surfaces.map((row) => row.surface)).toEqual([
      "consumer",
      "leaf",
    ]);
  });

  test("reuses only exact current rows and never bypasses a forced execution", () => {
    const expected = manifest([]);
    const rows = evidenceRows(expected);
    expect(resolveEvidenceRuns(expected, rows, NOW)).toEqual({
      consumer: false,
      leaf: false,
    });
    expect(resolveEvidenceRuns(expected, rows.slice(1), NOW)).toEqual({
      consumer: true,
      leaf: false,
    });
    const forced = manifest(["unknown/source.ts"]);
    expect(resolveEvidenceRuns(forced, evidenceRows(forced), NOW)).toEqual({
      consumer: true,
      leaf: true,
    });
  });

  test("rejects missing, duplicate, and unexpected rows", () => {
    const expected = manifest([]);
    const rows = evidenceRows(expected);
    expect(() => verifyCompleteManifest(expected, rows.slice(1), NOW)).toThrow(
      /missing current evidence/,
    );
    expect(() =>
      verifyCompleteManifest(expected, [...rows, rows[0]], NOW),
    ).toThrow(/duplicate observed/);
    expect(() =>
      verifyEvidence(expected, { ...rows[0], surface: "unexpected" }, NOW),
    ).toThrow(/unexpected evidence/);
  });

  test("rejects stale input, graph, environment, expiry, and tampered records", () => {
    const expected = manifest([]);
    const row = evidenceRows(expected)[0];
    const mutations = [
      [{ ...row, inputDigest: "0".repeat(64) }, /input digest mismatch/],
      [{ ...row, graphDigest: "0".repeat(64) }, /graph digest mismatch/],
      [
        { ...row, environmentDigest: "0".repeat(64) },
        /environment digest mismatch/,
      ],
      [
        {
          ...row,
          createdAt: "2026-08-20T12:00:00.000Z",
          expiresAt: "2026-08-21T11:59:59.000Z",
        },
        /evidence expired/,
      ],
      [
        { ...row, expiresAt: "2026-08-23T12:00:00.000Z" },
        /lifetime exceeds policy/,
      ],
      [{ ...row, sourceSha: "short" }, /invalid source SHA/],
      [{ ...row, sourceSha: "c".repeat(40) }, /evidence digest mismatch/],
    ] as const;
    for (const [candidate, error] of mutations) {
      expect(() => verifyEvidence(expected, candidate, NOW)).toThrow(error);
    }
  });

  test("rejects ambiguous fields and zero-work expected manifests", () => {
    const expected = manifest([]);
    const row = evidenceRows(expected)[0];
    expect(() =>
      verifyEvidence(expected, { ...row, legacyGreen: true }, NOW),
    ).toThrow(/ambiguous evidence fields/);
    expect(() =>
      verifyCompleteManifest({ ...expected, surfaces: [] }, [], NOW),
    ).toThrow(/zero surfaces/);
  });
});
