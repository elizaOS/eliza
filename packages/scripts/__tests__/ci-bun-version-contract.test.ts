/**
 * Pins the Bun runtime contract (#13402, #17044) against synthetic repo trees
 * and the real checkout. A clean tree passes (with `canary` named only in a
 * comment ignored), and each failure mode the contract exists to catch is
 * exercised red: divergent concrete pin, floating literal/env/matrix cell
 * (including inline flow mappings), mutable action tag, implicit setup-bun,
 * expressions whose backing declaration is missing OR out of scope (an env
 * declaration in a sibling job, matrix cells in a sibling job, workflow_call
 * inputs without a canonical default, composite step-output forms), files
 * that do not parse as YAML, unpinned bun.sh/install, `${BUN_VERSION}`
 * installs with no proven canonical default (shell scripts and Dockerfiles,
 * including defaults declared only after the use), Dockerfile ARG/FROM drift
 * with Docker's stage scoping (FROM interpolation requires a pre-FROM ARG
 * default; a bare in-stage re-declaration inherits the global default),
 * divergent release downloads (including releases/latest), presence-only and
 * unproven version-comparing install guards, drifting packageManager and
 * root type anchors, floating composite-action defaults, allowlist entries
 * that lack a reason, name no job, sit in the wrong job, or have no canonical
 * sibling job, a malformed tracked manifest, and a missing gate workflow
 * (fail-fast, not skip). Deterministic — no workflow runs, no network.
 */
import { describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
// Bun's test runner can return empty stdio pipes from node:child_process
// spawnSync; the captured adapter routes output through files instead.
import { spawnSync } from "../lib/spawn-sync-captured.mjs";

const { runContract, classifyTypeRange, isConcretePin } = await import(
  new URL("../ci-bun-version-contract.mjs", import.meta.url).href
);

const REAL_REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const CONTRACT_CLI_PATH = fileURLToPath(
  new URL("../ci-bun-version-contract.mjs", import.meta.url),
);

interface InventorySite {
  surface: string;
  file: string;
  line?: number;
  key?: string;
  origin?: string;
  value: string | null;
  classification: string;
  reason?: string;
}

const CANONICAL = "1.3.14";
const SHA = "0c5077e51419868618aeaa5fe8019c62421857d6";

const GATE_WORKFLOWS = [
  "test.yml",
  "develop-pr.yml",
  "cloud-cf-deploy.yml",
  "cloud-cf-release.yml",
];

// A gate stub that pins via a BUN_VERSION env literal and references it from
// the step by expression — the shape the real gates use. The comment naming
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
      - run: node packages/scripts/ci-bun-version-contract.mjs --inventory "$RUNNER_TEMP/bun-runtime-inventory.json"
      - uses: actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a
        with:
          name: bun-runtime-inventory
          path: \${{ runner.temp }}/bun-runtime-inventory.json
`;
}

function pinnedWorkflow(version = CANONICAL, ref = SHA): string {
  return `name: Lane
on: [push]
jobs:
  build:
    runs-on: ubuntu-24.04
    steps:
      - uses: oven-sh/setup-bun@${ref}
        with:
          bun-version: "${version}"
`;
}

const GATE_FLOATING = `name: Gate
on: [push]
jobs:
  build:
    runs-on: ubuntu-24.04
    steps:
      - uses: oven-sh/setup-bun@${SHA}
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

function buildRepo({
  version = CANONICAL,
  overrides = {},
  extra = {},
  files = {},
}: {
  version?: string;
  overrides?: Record<string, string | null>;
  extra?: Record<string, string>;
  files?: Record<string, string>;
}): string {
  const root = mkdtempSync(join(tmpdir(), "ci-bun-version-contract-"));
  mkdirSync(join(root, ".github", "workflows"), { recursive: true });
  writeFileSync(
    join(root, ".github", "ci-bun-version.json"),
    JSON.stringify({ version }),
  );
  for (const name of GATE_WORKFLOWS) {
    // `null` deletes a gate: the contract must fail loudly on a missing
    // required lane rather than skip it.
    if (overrides[name] === null) continue;
    writeFileSync(
      join(root, ".github", "workflows", name),
      overrides[name] ?? gateStub(),
    );
  }
  for (const [name, content] of Object.entries(extra)) {
    writeFileSync(join(root, ".github", "workflows", name), content);
  }
  for (const [rel, content] of Object.entries(files)) {
    const path = join(root, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
  return root;
}

function expectViolation(
  root: string,
  pattern: RegExp,
  overrides?: Record<string, unknown>,
) {
  try {
    expect(() => runContract(root, overrides)).toThrow(pattern);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function inventoryOf(
  root: string,
  overrides?: Record<string, unknown>,
): InventorySite[] {
  try {
    return runContract(root, overrides).inventory;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("ci-bun-version-contract", () => {
  test("parses concrete versions without backtracking on long invalid suffixes", () => {
    expect(isConcretePin("1.3.14")).toBe(true);
    expect(isConcretePin("1.3.14-canary.1+darwin-arm64")).toBe(true);
    expect(isConcretePin(`0.0.0+${"--".repeat(100_000)}!`)).toBe(false);
    expect(isConcretePin(`0.0.0-${"a.".repeat(100_000)}`)).toBe(false);
  });

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
    expectViolation(
      buildRepo({ extra: { "drift.yml": pinnedWorkflow("1.3.99") } }),
      /canonical CI Bun version is 1\.3\.14/,
    );
  });

  test("fails when a gate workflow floats back to canary", () => {
    expectViolation(
      buildRepo({ overrides: { "test.yml": GATE_FLOATING } }),
      /wires floating Bun/,
    );
  });

  test("fails when a gate workflow drops the canonical pin entirely", () => {
    expectViolation(
      buildRepo({ overrides: { "cloud-cf-deploy.yml": GATE_NO_PIN } }),
      /does not wire the canonical Bun pin/,
    );
  });

  test("fails loudly when a gate workflow is missing, instead of skipping", () => {
    expectViolation(
      buildRepo({ overrides: { "cloud-cf-deploy.yml": null } }),
      /cloud-cf-deploy\.yml/,
    );
  });

  test("fails loudly when the canonical release workflow is missing (#19183)", () => {
    // After #18996 split the canary deploy from the canonical release, the
    // release workflow publishes to production. A missing release gate must
    // fail loudly the same way a missing canary gate does, not silently pass.
    expectViolation(
      buildRepo({ overrides: { "cloud-cf-release.yml": null } }),
      /cloud-cf-release\.yml/,
    );
  });

  test("fails when the source of truth itself floats", () => {
    const root = buildRepo({ version: "canary" });
    try {
      expect(() => runContract(root)).toThrow(/must be a concrete Bun pin/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("fails a mutable setup-bun tag even when the version is canonical", () => {
    expectViolation(
      buildRepo({ extra: { "mutable.yml": pinnedWorkflow(CANONICAL, "v2") } }),
      /not pinned to a reviewed commit SHA/,
    );
  });

  test("fails an implicit setup-bun use (no bun-version wired)", () => {
    const implicit = `name: Lane
on: [push]
jobs:
  build:
    runs-on: ubuntu-24.04
    steps:
      - uses: oven-sh/setup-bun@${SHA}
      - run: bun install
`;
    expectViolation(
      buildRepo({ extra: { "implicit.yml": implicit } }),
      /wires no bun-version/,
    );
  });

  test("fails a floating matrix cell in flow-list form", () => {
    const matrix = `name: Lane
on: [push]
jobs:
  build:
    strategy:
      matrix:
        bun-version: ["canary"]
    runs-on: ubuntu-24.04
    steps:
      - uses: oven-sh/setup-bun@${SHA}
        with:
          bun-version: \${{ matrix.bun-version }}
`;
    expectViolation(
      buildRepo({ extra: { "matrix.yml": matrix } }),
      /wires floating Bun/,
    );
  });

  test("fails a floating matrix cell in block-list form", () => {
    const matrix = `name: Lane
on: [push]
jobs:
  build:
    strategy:
      matrix:
        bun-version:
          - canary
    runs-on: ubuntu-24.04
    steps:
      - uses: oven-sh/setup-bun@${SHA}
        with:
          bun-version: \${{ matrix.bun-version }}
`;
    expectViolation(
      buildRepo({ extra: { "matrix-block.yml": matrix } }),
      /wires floating Bun/,
    );
  });

  test("fails an env expression whose BUN_VERSION declaration is missing", () => {
    const unbacked = `name: Lane
on: [push]
jobs:
  build:
    runs-on: ubuntu-24.04
    steps:
      - uses: oven-sh/setup-bun@${SHA}
        with:
          bun-version: \${{ env.BUN_VERSION }}
`;
    expectViolation(
      buildRepo({ extra: { "unbacked-env.yml": unbacked } }),
      /unbound expression.*no BUN_VERSION declaration/,
    );
  });

  test("fails a matrix expression with no bun-version cells to resolve", () => {
    const unbacked = `name: Lane
on: [push]
jobs:
  build:
    runs-on: ubuntu-24.04
    steps:
      - uses: oven-sh/setup-bun@${SHA}
        with:
          bun-version: \${{ matrix.bun-version }}
`;
    expectViolation(
      buildRepo({ extra: { "unbacked-matrix.yml": unbacked } }),
      /unbound expression.*no bun-version matrix cells/,
    );
  });

  test("fails a step-output expression that cannot be proven pinned", () => {
    const unbound = `name: Lane
on: [push]
jobs:
  build:
    runs-on: ubuntu-24.04
    steps:
      - uses: oven-sh/setup-bun@${SHA}
        with:
          bun-version: \${{ steps.resolver.outputs.version }}
`;
    expectViolation(
      buildRepo({ extra: { "unbound.yml": unbound } }),
      /unbound expression/,
    );
  });

  test("fails a composite action wiring a step-output instead of its input", () => {
    const action = `name: Setup
inputs:
  bun-version:
    description: "Bun version"
    required: false
    default: "${CANONICAL}"
runs:
  using: composite
  steps:
    - uses: oven-sh/setup-bun@${SHA}
      with:
        bun-version: \${{ steps.resolve.outputs.version }}
`;
    expectViolation(
      buildRepo({ files: { ".github/actions/setup/action.yml": action } }),
      /unbound expression/,
    );
  });

  test("fails a bun.sh/install without the pinned release tag", () => {
    const shell = `name: Deploy
on: [push]
jobs:
  deploy:
    runs-on: ubuntu-24.04
    steps:
      - run: |
          curl -fsSL https://bun.sh/install | bash -s "canary"
`;
    expectViolation(
      buildRepo({ extra: { "shell.yml": shell } }),
      /bun\.sh\/install without the pinned release tag/,
    );
  });

  test("scans shell scripts outside workflows as install surfaces", () => {
    expectViolation(
      buildRepo({
        files: {
          "deploy/install.sh": "curl -fsSL https://bun.sh/install | bash\n",
        },
      }),
      /deploy\/install\.sh:1: bun\.sh\/install without the pinned release tag/,
    );
  });

  test("rejects an install guard that trusts any preinstalled Bun version", () => {
    expectViolation(
      buildRepo({
        files: {
          "deploy/install.sh": [
            "if ! command -v bun >/dev/null 2>&1; then",
            `  curl -fsSL https://bun.sh/install | bash -s "bun-v${CANONICAL}"`,
            "fi",
            "",
          ].join("\n"),
        },
      }),
      /guarded only by executable presence/,
    );
  });

  test("rejects a presence-only guard embedded in a generated script", () => {
    expectViolation(
      buildRepo({
        files: {
          "deploy/generate.mjs": [
            "const script = [",
            '  "if ! command -v bun >/dev/null 2>&1; then",',
            `  '  curl -fsSL https://bun.sh/install | bash -s "bun-v${CANONICAL}"',`,
            '  "fi",',
            '].join("\\n");',
            "",
          ].join("\n"),
        },
      }),
      /guarded only by executable presence/,
    );
  });

  test("fails a Dockerfile whose BUN_VERSION default floats", () => {
    expectViolation(
      buildRepo({
        files: {
          "services/runner/Dockerfile": [
            "FROM node:24-slim",
            "ARG BUN_VERSION=canary",
            // biome-ignore lint/suspicious/noTemplateCurlyInString: Dockerfile ARG interpolation, not a JS template
            'RUN curl -fsSL https://bun.sh/install | bash -s "bun-v${BUN_VERSION}"',
            "",
          ].join("\n"),
        },
      }),
      /BUN_VERSION defaults to canary/,
    );
  });

  test("fails a floating oven/bun base image and passes canonical variants", () => {
    expectViolation(
      buildRepo({ files: { "sim/Dockerfile": "FROM oven/bun:canary\n" } }),
      /FROM oven\/bun:canary/,
    );
    const inventory = inventoryOf(
      buildRepo({
        files: {
          "sim/Dockerfile": `FROM oven/bun:${CANONICAL}-alpine\n`,
          "runner/Dockerfile": [
            "FROM node:24-slim",
            `ARG BUN_VERSION=${CANONICAL}`,
            // biome-ignore lint/suspicious/noTemplateCurlyInString: Dockerfile ARG interpolation, not a JS template
            'RUN curl -fsSL https://bun.sh/install | bash -s "bun-v${BUN_VERSION}"',
            "",
          ].join("\n"),
        },
      }),
    );
    const image = inventory.find((s) => s.surface === "dockerfile-base-image");
    expect(image?.classification).toBe("canonical");
    const install = inventory.find(
      (s) => s.surface === "shell-install" && s.file === "runner/Dockerfile",
    );
    expect(install?.classification).toBe("canonical");
  });

  test("fails a base image reached through a non-BUN_VERSION ARG", () => {
    // The shape the deployed cloud services use. The image reference never
    // touches a FROM line, so the `FROM oven/bun:` matcher never sees it, and
    // the ARG is not named BUN_VERSION, so the ARG scan skips it too — a
    // floating canary rode into three production images past a contract whose
    // headline promise is that no floating tag survives (#17044).
    expectViolation(
      buildRepo({
        files: {
          "services/gw/Dockerfile": [
            "ARG BUN_BASE=oven/bun:canary-alpine",
            // biome-ignore lint/suspicious/noTemplateCurlyInString: Dockerfile ARG interpolation, not a JS template
            "FROM ${BUN_BASE} AS base",
            "",
          ].join("\n"),
        },
      }),
      /ARG BUN_BASE=oven\/bun:canary-alpine/,
    );
    expectViolation(
      buildRepo({
        files: {
          "services/gw/Dockerfile": [
            "ENV BUN_IMAGE=oven/bun:latest",
            // biome-ignore lint/suspicious/noTemplateCurlyInString: Dockerfile ARG interpolation, not a JS template
            "FROM ${BUN_IMAGE}",
            "",
          ].join("\n"),
        },
      }),
      /oven\/bun:latest/,
    );
  });

  test("accepts a canonical base image reached through an ARG, variant included", () => {
    const inventory = inventoryOf(
      buildRepo({
        files: {
          "services/gw/Dockerfile": [
            `ARG BUN_BASE=oven/bun:${CANONICAL}-alpine`,
            // biome-ignore lint/suspicious/noTemplateCurlyInString: Dockerfile ARG interpolation, not a JS template
            "FROM ${BUN_BASE} AS base",
            "",
          ].join("\n"),
        },
      }),
    );
    const arg = inventory.find(
      (s) => s.surface === "dockerfile-base-image-arg",
    );
    expect(arg?.classification).toBe("canonical");
    expect(arg?.value).toBe(`${CANONICAL}-alpine`);
  });

  test("leaves a non-oven ARG default alone (local RISC-V build override)", () => {
    // riscv64 has no upstream oven/bun image, so these Dockerfiles document a
    // locally built tag passed via --build-arg. It declares no oven/bun
    // runtime and must not be forced onto the canonical pin.
    const inventory = inventoryOf(
      buildRepo({
        files: {
          "services/gw/Dockerfile": [
            "ARG BUN_BASE=local/bun-riscv64:dev",
            // biome-ignore lint/suspicious/noTemplateCurlyInString: Dockerfile ARG interpolation, not a JS template
            "FROM ${BUN_BASE} AS base",
            "",
          ].join("\n"),
        },
      }),
    );
    expect(
      inventory.filter((s) => s.surface === "dockerfile-base-image-arg"),
    ).toEqual([]);
  });

  test("fails a divergent oven-sh release download URL", () => {
    expectViolation(
      buildRepo({
        files: {
          "infra/bootstrap.yaml.tftpl":
            "  - su - deploy -c 'curl -fsSL -o /tmp/bun.zip https://github.com/oven-sh/bun/releases/download/bun-v1.3.13/bun-linux-x64.zip'\n",
        },
      }),
      /downloads Bun release bun-v1\.3\.13/,
    );
  });

  test("fails a floating latest Bun download in a standalone YAML manifest", () => {
    expectViolation(
      buildRepo({
        files: {
          "packaging/snap/snapcraft.yaml":
            'override-build: curl -fsSL "https://github.com/oven-sh/bun/releases/latest/download/bun-linux-x64.zip" -o /tmp/bun.zip\n',
        },
      }),
      /downloads Bun from floating releases\/latest/,
    );
  });

  test("fails when the required develop PR gate drops contract enforcement", () => {
    expectViolation(
      buildRepo({
        overrides: {
          "develop-pr.yml": gateStub().replace(
            /\s+- run: node packages\/scripts\/ci-bun-version-contract\.mjs --inventory[^\n]+/,
            "",
          ),
        },
      }),
      /develop-pr\.yml: required lane does not execute the Bun contract/,
    );
  });

  test("fails a packageManager declaring a non-canonical Bun", () => {
    expectViolation(
      buildRepo({
        files: {
          "package.json": JSON.stringify({ packageManager: "bun@1.4.0" }),
        },
      }),
      /packageManager is bun@1\.4\.0/,
    );
  });

  test("fails loudly on a malformed tracked manifest instead of skipping it", () => {
    expectViolation(
      buildRepo({ files: { "packages/bad/package.json": "{ not json" } }),
      /packages\/bad\/package\.json: tracked manifest failed to parse/,
    );
  });

  test("fails a root type anchor that is not the exact canonical version", () => {
    expectViolation(
      buildRepo({
        files: {
          "package.json": JSON.stringify({
            packageManager: `bun@${CANONICAL}`,
            devDependencies: { "@types/bun": "^1.3.12" },
          }),
        },
      }),
      /root type anchor/,
    );
  });

  test("classifies workspace type ranges without failing the contract", () => {
    const inventory = inventoryOf(
      buildRepo({
        files: {
          "package.json": JSON.stringify({
            packageManager: `bun@${CANONICAL}`,
            devDependencies: { "bun-types": CANONICAL },
          }),
          "packages/a/package.json": JSON.stringify({
            devDependencies: { "bun-types": "^1.2.0" },
          }),
          "packages/b/package.json": JSON.stringify({
            devDependencies: { "bun-types": "1.3.13" },
          }),
        },
      }),
    );
    const ranges = inventory.filter(
      (s) => s.surface === "workspace-type-range",
    );
    expect(
      ranges.find((s) => s.file.includes("packages/a"))?.classification,
    ).toBe("compatible-range");
    expect(
      ranges.find((s) => s.file.includes("packages/b"))?.classification,
    ).toBe("drift");
  });

  test("fails a composite action whose bun-version input defaults floating", () => {
    const action = `name: Setup
inputs:
  bun-version:
    description: "Bun version"
    required: false
    default: "canary"
runs:
  using: composite
  steps:
    - uses: oven-sh/setup-bun@${SHA}
      with:
        bun-version: \${{ inputs.bun-version }}
`;
    expectViolation(
      buildRepo({ files: { ".github/actions/setup/action.yml": action } }),
      /composite bun-version input defaults/,
    );
  });

  test("passes a composite action defaulting to the canonical pin", () => {
    const action = `name: Setup
inputs:
  bun-version:
    description: "Bun version"
    required: false
    default: "${CANONICAL}"
runs:
  using: composite
  steps:
    - uses: oven-sh/setup-bun@${SHA}
      with:
        bun-version: \${{ inputs.bun-version }}
`;
    const inventory = inventoryOf(
      buildRepo({ files: { ".github/actions/setup/action.yml": action } }),
    );
    const site = inventory.find((s) => s.surface === "composite-default");
    expect(site?.classification).toBe("canonical");
  });

  test("rejects an allowlist entry with no reason", () => {
    expectViolation(
      buildRepo({ extra: { "compat.yml": gateStub() } }),
      /has no reason/,
      {
        floatingAllowlist: [
          {
            file: ".github/workflows/compat.yml",
            job: "build",
            value: "canary",
            reason: "",
          },
        ],
      },
    );
  });

  test("rejects an allowlist entry that names no job", () => {
    expectViolation(
      buildRepo({ extra: { "compat.yml": gateStub() } }),
      /names no job/,
      {
        floatingAllowlist: [
          {
            file: ".github/workflows/compat.yml",
            value: "canary",
            reason: "upstream compatibility cell (test)",
          },
        ],
      },
    );
  });

  test("rejects an allowlisted canary with no canonical sibling job", () => {
    const canaryOnly = `name: Compat
on: [push]
jobs:
  canary-cell:
    runs-on: ubuntu-24.04
    steps:
      - uses: oven-sh/setup-bun@${SHA}
        with:
          bun-version: canary
`;
    expectViolation(
      buildRepo({ extra: { "compat.yml": canaryOnly } }),
      /no canonical sibling lane/,
      {
        floatingAllowlist: [
          {
            file: ".github/workflows/compat.yml",
            job: "canary-cell",
            value: "canary",
            reason: "upstream compatibility cell (test)",
          },
        ],
      },
    );
  });

  test("rejects an allowlisted canary whose sibling canonical pin lives in the SAME job", () => {
    const sameJob = `name: Compat
on: [push]
jobs:
  canary-cell:
    runs-on: ubuntu-24.04
    steps:
      - uses: oven-sh/setup-bun@${SHA}
        with:
          bun-version: "${CANONICAL}"
      - uses: oven-sh/setup-bun@${SHA}
        with:
          bun-version: canary
`;
    expectViolation(
      buildRepo({ extra: { "compat.yml": sameJob } }),
      /no canonical sibling lane/,
      {
        floatingAllowlist: [
          {
            file: ".github/workflows/compat.yml",
            job: "canary-cell",
            value: "canary",
            reason: "upstream compatibility cell (test)",
          },
        ],
      },
    );
  });

  test("rejects a floating cell in a job the allowlist entry does not name", () => {
    const wrongJob = `name: Compat
on: [push]
jobs:
  pinned:
    runs-on: ubuntu-24.04
    steps:
      - uses: oven-sh/setup-bun@${SHA}
        with:
          bun-version: "${CANONICAL}"
  drifted:
    runs-on: ubuntu-24.04
    steps:
      - uses: oven-sh/setup-bun@${SHA}
        with:
          bun-version: canary
`;
    expectViolation(
      buildRepo({ extra: { "compat.yml": wrongJob } }),
      /wires floating Bun "canary" in job "drifted"/,
      {
        floatingAllowlist: [
          {
            file: ".github/workflows/compat.yml",
            job: "some-other-job",
            value: "canary",
            reason: "upstream compatibility cell (test)",
          },
        ],
      },
    );
  });

  test("permits an allowlisted floating cell beside a canonical sibling job", () => {
    const additive = `name: Compat
on: [push]
env:
  BUN_VERSION: "${CANONICAL}"
jobs:
  pinned:
    runs-on: ubuntu-24.04
    steps:
      - uses: oven-sh/setup-bun@${SHA}
        with:
          bun-version: \${{ env.BUN_VERSION }}
  canary-cell:
    runs-on: ubuntu-24.04
    steps:
      - uses: oven-sh/setup-bun@${SHA}
        with:
          bun-version: canary
`;
    const inventory = inventoryOf(
      buildRepo({ extra: { "compat.yml": additive } }),
      {
        floatingAllowlist: [
          {
            file: ".github/workflows/compat.yml",
            job: "canary-cell",
            value: "canary",
            reason: "upstream compatibility cell (test)",
          },
        ],
      },
    );
    const site = inventory.find(
      (s) => s.file === ".github/workflows/compat.yml" && s.value === "canary",
    );
    expect(site?.classification).toBe("allowlisted-floating");
  });

  test("rejects an env expression whose declaration lives in a SIBLING job", () => {
    // GitHub resolves env.BUN_VERSION step -> job -> workflow; a declaration
    // inside another job is invisible at runtime, so file-wide resolution
    // would prove nothing (maintainer review on #17599).
    const crossJob = `name: Lane
on: [push]
jobs:
  declares:
    runs-on: ubuntu-24.04
    env:
      BUN_VERSION: "${CANONICAL}"
    steps:
      - run: echo ok
  reads:
    runs-on: ubuntu-24.04
    steps:
      - uses: oven-sh/setup-bun@${SHA}
        with:
          bun-version: \${{ env.BUN_VERSION }}
`;
    expectViolation(
      buildRepo({ extra: { "cross-job-env.yml": crossJob } }),
      /unbound expression.*no BUN_VERSION declaration visible to job "reads"/,
    );
  });

  test("resolves a job-level env declaration for that job's own steps", () => {
    const jobScoped = `name: Lane
on: [push]
jobs:
  build:
    runs-on: ubuntu-24.04
    env:
      BUN_VERSION: "${CANONICAL}"
    steps:
      - uses: oven-sh/setup-bun@${SHA}
        with:
          bun-version: \${{ env.BUN_VERSION }}
`;
    const inventory = inventoryOf(
      buildRepo({ extra: { "job-env.yml": jobScoped } }),
    );
    const site = inventory.find(
      (s) =>
        s.file === ".github/workflows/job-env.yml" &&
        s.classification === "resolvable-expression",
    );
    expect(site).toBeDefined();
  });

  test("resolves a step-level env declaration for that step only", () => {
    const stepScoped = `name: Lane
on: [push]
jobs:
  build:
    runs-on: ubuntu-24.04
    steps:
      - uses: oven-sh/setup-bun@${SHA}
        env:
          BUN_VERSION: "${CANONICAL}"
        with:
          bun-version: \${{ env.BUN_VERSION }}
`;
    const inventory = inventoryOf(
      buildRepo({ extra: { "step-env.yml": stepScoped } }),
    );
    const site = inventory.find(
      (s) =>
        s.file === ".github/workflows/step-env.yml" &&
        s.origin === "with" &&
        s.classification === "resolvable-expression",
    );
    expect(site).toBeDefined();
  });

  test("rejects a matrix expression whose cells live in a SIBLING job", () => {
    const crossJob = `name: Lane
on: [push]
jobs:
  declares:
    strategy:
      matrix:
        bun-version: ["${CANONICAL}"]
    runs-on: ubuntu-24.04
    steps:
      - run: echo ok
  reads:
    runs-on: ubuntu-24.04
    steps:
      - uses: oven-sh/setup-bun@${SHA}
        with:
          bun-version: \${{ matrix.bun-version }}
`;
    expectViolation(
      buildRepo({ extra: { "cross-job-matrix.yml": crossJob } }),
      /unbound expression.*no bun-version matrix cells declared by job "reads"/,
    );
  });

  test("catches a floating pin hidden in an inline flow mapping", () => {
    // `with: { bun-version: canary }` never matched the old line-based
    // key scan; structured parsing sees every mapping shape.
    const inline = `name: Lane
on: [push]
jobs:
  build:
    runs-on: ubuntu-24.04
    steps:
      - uses: oven-sh/setup-bun@${SHA}
        with: { bun-version: canary }
`;
    expectViolation(
      buildRepo({ extra: { "inline-flow.yml": inline } }),
      /wires floating Bun "canary" in job "build"/,
    );
  });

  test("fails a workflow file that does not parse as YAML", () => {
    const broken = `name: Lane
on: [push]
jobs:
  build:
    steps:
      - uses: x
     badindent: [unclosed
`;
    expectViolation(
      buildRepo({ extra: { "broken.yml": broken } }),
      /does not parse as YAML/,
    );
  });

  test("resolves inputs.bun-version against a workflow_call input with a canonical default", () => {
    const reusable = `name: Reusable
on:
  workflow_call:
    inputs:
      bun-version:
        description: "Bun version"
        required: false
        default: "${CANONICAL}"
jobs:
  build:
    runs-on: ubuntu-24.04
    steps:
      - uses: oven-sh/setup-bun@${SHA}
        with:
          bun-version: \${{ inputs.bun-version }}
`;
    const inventory = inventoryOf(
      buildRepo({ extra: { "reusable.yml": reusable } }),
    );
    const site = inventory.find(
      (s) =>
        s.file === ".github/workflows/reusable.yml" &&
        s.origin === "with" &&
        s.classification === "resolvable-expression",
    );
    expect(site).toBeDefined();
  });

  test("rejects inputs.bun-version when the workflow_call input has no canonical default", () => {
    const reusable = `name: Reusable
on:
  workflow_call:
    inputs:
      bun-version:
        description: "Bun version"
        required: true
jobs:
  build:
    runs-on: ubuntu-24.04
    steps:
      - uses: oven-sh/setup-bun@${SHA}
        with:
          bun-version: \${{ inputs.bun-version }}
`;
    expectViolation(
      buildRepo({ extra: { "reusable.yml": reusable } }),
      /unbound expression/,
    );
  });

  test("rejects FROM oven/bun interpolation with no pre-FROM ARG default", () => {
    expectViolation(
      buildRepo({
        files: {
          "services/api/Dockerfile": [
            // biome-ignore lint/suspicious/noTemplateCurlyInString: Dockerfile ARG interpolation, not a JS template
            "FROM oven/bun:${BUN_VERSION}",
            'RUN echo "hi"',
            "",
          ].join("\n"),
        },
      }),
      /interpolates \$\{BUN_VERSION\} with no pre-FROM ARG BUN_VERSION default/,
    );
  });

  test("rejects FROM interpolation whose only ARG default is stage-scoped (after a FROM)", () => {
    // Docker: an ARG declared after any FROM belongs to that stage and is
    // invisible to later FROM lines — only pre-first-FROM ARGs are global.
    expectViolation(
      buildRepo({
        files: {
          "services/api/Dockerfile": [
            "FROM node:24-slim AS builder",
            `ARG BUN_VERSION=${CANONICAL}`,
            "RUN echo builder",
            // biome-ignore lint/suspicious/noTemplateCurlyInString: Dockerfile ARG interpolation, not a JS template
            "FROM oven/bun:${BUN_VERSION} AS runtime",
            "",
          ].join("\n"),
        },
      }),
      /no pre-FROM ARG BUN_VERSION default/,
    );
  });

  test("accepts the global-ARG + bare stage re-declaration Dockerfile shape", () => {
    // The shape packages/app-core/deploy/Dockerfile.ci actually uses.
    const inventory = inventoryOf(
      buildRepo({
        files: {
          "deploy/Dockerfile.ci": [
            `ARG BUN_VERSION=${CANONICAL}`,
            "FROM node:24-slim AS base",
            "RUN echo base",
            // biome-ignore lint/suspicious/noTemplateCurlyInString: Dockerfile ARG interpolation, not a JS template
            "FROM oven/bun:${BUN_VERSION} AS bun-runtime",
            "ARG BUN_VERSION",
            // biome-ignore lint/suspicious/noTemplateCurlyInString: Dockerfile ARG interpolation, not a JS template
            'RUN curl -fsSL https://bun.sh/install | bash -s "bun-v${BUN_VERSION}"',
            "",
          ].join("\n"),
        },
      }),
    );
    const image = inventory.find((s) => s.surface === "dockerfile-base-image");
    expect(image?.classification).toBe("resolvable-expression");
    const redecl = inventory.find(
      (s) => s.surface === "dockerfile-arg-redeclaration",
    );
    expect(redecl?.classification).toBe("inherits-global-default");
    const install = inventory.find((s) => s.surface === "shell-install");
    expect(install?.classification).toBe("canonical");
  });

  test("rejects a bare ARG BUN_VERSION with no global default to inherit", () => {
    expectViolation(
      buildRepo({
        files: {
          "deploy/Dockerfile": [
            "FROM oven/bun:1.3.14 AS runtime",
            "ARG BUN_VERSION",
            // biome-ignore lint/suspicious/noTemplateCurlyInString: Dockerfile ARG interpolation, not a JS template
            'RUN curl -fsSL https://bun.sh/install | bash -s "bun-v${BUN_VERSION}"',
            "",
          ].join("\n"),
        },
      }),
      /bare ARG BUN_VERSION has no pre-FROM default to inherit/,
    );
  });

  test("accepts a canonical inline FROM default and rejects a divergent one", () => {
    const inventory = inventoryOf(
      buildRepo({
        files: {
          "ok/Dockerfile": `FROM oven/bun:\${BUN_VERSION:-${CANONICAL}}\n`,
        },
      }),
    );
    expect(
      inventory.find((s) => s.surface === "dockerfile-base-image")
        ?.classification,
    ).toBe("resolvable-expression");
    expectViolation(
      buildRepo({
        files: {
          // biome-ignore lint/suspicious/noTemplateCurlyInString: Dockerfile ARG interpolation, not a JS template
          "bad/Dockerfile": "FROM oven/bun:${BUN_VERSION:-1.2.0}\n",
        },
      }),
      /inline \$\{BUN_VERSION:-…\} default must be the canonical/,
    );
  });

  test("rejects a shell BUN_VERSION-expression install with no proven default", () => {
    expectViolation(
      buildRepo({
        files: {
          "deploy/install.sh": [
            "#!/usr/bin/env bash",
            // biome-ignore lint/suspicious/noTemplateCurlyInString: shell variable reference, not a JS template
            'curl -fsSL https://bun.sh/install | bash -s "bun-v${BUN_VERSION}"',
            "",
          ].join("\n"),
        },
      }),
      /never proves a canonical BUN_VERSION default before the use/,
    );
  });

  test("rejects a shell default declared only AFTER the install uses it", () => {
    expectViolation(
      buildRepo({
        files: {
          "deploy/install.sh": [
            "#!/usr/bin/env bash",
            // biome-ignore lint/suspicious/noTemplateCurlyInString: shell variable reference, not a JS template
            'curl -fsSL https://bun.sh/install | bash -s "bun-v${BUN_VERSION}"',
            `BUN_VERSION="\${BUN_VERSION:-${CANONICAL}}"`,
            "",
          ].join("\n"),
        },
      }),
      /never proves a canonical BUN_VERSION default before the use/,
    );
  });

  test("accepts a shell BUN_VERSION-expression install behind a canonical default", () => {
    // The docker-ci-smoke.sh shape: default first, guard and install after.
    const inventory = inventoryOf(
      buildRepo({
        files: {
          "deploy/install.sh": [
            "#!/usr/bin/env bash",
            `BUN_VERSION="\${BUN_VERSION:-${CANONICAL}}"`,
            // biome-ignore lint/suspicious/noTemplateCurlyInString: shell variable reference, not a JS template
            'if command -v bun >/dev/null 2>&1 && [ "$(bun --version)" = "${BUN_VERSION}" ]; then',
            '  echo "bun already pinned"',
            "else",
            // biome-ignore lint/suspicious/noTemplateCurlyInString: shell variable reference, not a JS template
            '  curl -fsSL https://bun.sh/install | bash -s "bun-v${BUN_VERSION}"',
            "fi",
            "",
          ].join("\n"),
        },
      }),
    );
    const install = inventory.find((s) => s.surface === "shell-install");
    expect(install?.classification).toBe("canonical");
    const defaultSite = inventory.find((s) => s.surface === "shell-default");
    expect(defaultSite?.classification).toBe("canonical");
  });

  test("rejects a version-comparing guard whose BUN_VERSION is never defaulted", () => {
    expectViolation(
      buildRepo({
        files: {
          "deploy/install.sh": [
            "#!/usr/bin/env bash",
            // biome-ignore lint/suspicious/noTemplateCurlyInString: shell variable reference, not a JS template
            'if command -v bun >/dev/null 2>&1 && [ "$(bun --version)" = "${BUN_VERSION}" ]; then',
            '  echo "bun already present"',
            "else",
            `  curl -fsSL https://bun.sh/install | bash -s "bun-v${CANONICAL}"`,
            "fi",
            "",
          ].join("\n"),
        },
      }),
      /never proves a canonical BUN_VERSION default before the comparison/,
    );
  });

  test("classifyTypeRange models the syntaxes this repo uses", () => {
    expect(classifyTypeRange(CANONICAL, CANONICAL)).toBe("exact-canonical");
    expect(classifyTypeRange("*", CANONICAL)).toBe("compatible-range");
    expect(classifyTypeRange("^1.2.25", CANONICAL)).toBe("compatible-range");
    expect(classifyTypeRange("~1.3.2", CANONICAL)).toBe("compatible-range");
    expect(classifyTypeRange("~1.2.0", CANONICAL)).toBe("drift");
    expect(classifyTypeRange("1.3.13", CANONICAL)).toBe("drift");
    expect(classifyTypeRange("^2.0.0", CANONICAL)).toBe("drift");
    expect(classifyTypeRange("workspace:*", CANONICAL)).toBe("unparseable");
  });

  test("the real repo satisfies the contract", () => {
    const result = runContract(REAL_REPO_ROOT);
    const canonical: string = result.canonical;
    const inventory: InventorySite[] = result.inventory;
    const gateWorkflows: string[] = result.gateWorkflows;
    expect(canonical).toBe(CANONICAL);
    expect(gateWorkflows.length).toBeGreaterThan(0);
    // The repo genuinely has every surface the contract models; an empty scan
    // would mean the tracked-file enumeration or a reader silently broke.
    for (const surface of [
      "workflow-version",
      "setup-bun-ref",
      "shell-install",
      "preinstalled-runtime-guard",
      "release-download",
      "dockerfile-arg-default",
      "dockerfile-base-image",
      "packageManager",
      "root-type-anchor",
      "workspace-type-range",
      "composite-default",
    ]) {
      expect(inventory.some((s) => s.surface === surface)).toBe(true);
    }
    // The scoped-out boundaries are inventoried as exclusions, never silent.
    expect(
      inventory.some((s) => s.classification === "embedded-boundary-excluded"),
    ).toBe(true);
    expect(
      inventory.filter((s) => s.classification === "floating").length,
    ).toBe(0);
    expect(
      inventory.filter((s) => s.classification === "unreviewed-ref").length,
    ).toBe(0);
    expect(
      inventory.filter((s) => s.classification === "unbound-expression").length,
    ).toBe(0);
  }, 15_000);

  test("the contract CLI executes directly and writes an inventory on this platform", () => {
    const root = mkdtempSync(join(tmpdir(), "ci-bun-version-contract-cli-"));
    const inventoryPath = join(root, "inventory.json");
    try {
      const result = spawnSync(
        process.execPath,
        [CONTRACT_CLI_PATH, "--inventory", inventoryPath],
        {
          cwd: REAL_REPO_ROOT,
          encoding: "utf8",
        },
      );
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain(
        "ci bun version contract passed (canonical 1.3.14",
      );
      const inventory = JSON.parse(readFileSync(inventoryPath, "utf8"));
      expect(inventory.canonical).toBe(CANONICAL);
      expect(inventory.sites.length).toBeGreaterThan(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 15_000);

  test("scans a non-.github workflow whose setup-bun wires no version", () => {
    // The scan precondition required a `bun-version:` key before a non-.github
    // YAML entered the inventory — but a setup-bun step with no version has no
    // such key, so every file invariant 2 exists to catch selected itself out.
    // 16 plugin workflows ran the action's floating "latest" default while the
    // gate reported a clean sweep.
    expectViolation(
      buildRepo({
        files: {
          "plugins/plugin-example/.github/workflows/npm-deploy.yml": `name: Publish
on: [push]
jobs:
  build:
    runs-on: ubuntu-24.04
    steps:
      - uses: oven-sh/setup-bun@${SHA}
`,
        },
      }),
      /wires no bun-version/,
    );
  });

  test("flags an oven/bun image embedded in a shell heredoc", () => {
    // scanDockerfile only inspects files NAMED Dockerfile, so a deploy script
    // that writes one at runtime shipped `canary` past the contract.
    expectViolation(
      buildRepo({
        files: {
          "services/x/deploy.sh": `#!/usr/bin/env bash
cat > "$STAGE/Dockerfile" <<'DOCKER'
FROM oven/bun:canary-alpine
DOCKER
`,
        },
      }),
      /oven\/bun:canary-alpine/,
    );
  });

  test("accepts a canonical embedded image with a variant suffix", () => {
    // The variant is a base-image choice, not a version — flagging -alpine
    // would make the rule unusable for the deploy scripts that need it.
    const inventory = inventoryOf(
      buildRepo({
        files: {
          "services/x/deploy.sh": `#!/usr/bin/env bash
FROM_LINE="FROM oven/bun:${CANONICAL}-alpine"
`,
        },
      }),
    );
    const site = inventory.find((s) => s.surface === "embedded-bun-image");
    expect(site?.classification).toBe("canonical");
    expect(site?.value).toBe(`${CANONICAL}-alpine`);
  });

  test("proves a BUN_VERSION default declared in a YAML-embedded shell script", () => {
    // A packaging manifest carries its build steps as an embedded shell script.
    // Reading defaults only from `.sh` left the ${BUN_VERSION} use unproven,
    // and the only way to satisfy the contract was to inline the literal at the
    // use site — which is how the pin ended up written twice.
    const inventory = inventoryOf(
      buildRepo({
        files: {
          "packaging/snap/snapcraft.yaml": `name: eliza
parts:
  bun:
    override-build: |
      BUN_VERSION="${CANONICAL}"
      curl -fsSL "https://github.com/oven-sh/bun/releases/download/bun-v\${BUN_VERSION}/bun-linux-x64.zip" -o /tmp/bun.zip
`,
        },
      }),
    );
    const site = inventory.find(
      (s) =>
        s.file === "packaging/snap/snapcraft.yaml" && s.value === CANONICAL,
    );
    expect(site?.classification).toBe("canonical");
  });

  test("names the file when a tracked path cannot be read", () => {
    // git ls-files can list a path the working tree lacks (sparse checkout,
    // uninitialised submodule). That surfaced as a raw ENOENT naming neither
    // the contract nor the file, so a CI operator saw a crash instead of which
    // surface broke the inventory. Needs a REAL git checkout: a synthetic tree
    // falls back to a directory walk, which cannot list an absent file.
    const root = buildRepo({});
    const git = (...args: string[]) =>
      spawnSync("git", args, { cwd: root, encoding: "utf8" });
    git("init", "-q");
    git("config", "user.email", "t@example.com");
    git("config", "user.name", "t");
    const missing = join(root, "packages", "gone", "Dockerfile");
    mkdirSync(dirname(missing), { recursive: true });
    writeFileSync(missing, `FROM oven/bun:${CANONICAL}\n`);
    git("add", "-A");
    git("commit", "-qm", "fixture");
    rmSync(missing);
    try {
      expect(() => runContract(root)).toThrow(/tracked by git but unreadable/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
