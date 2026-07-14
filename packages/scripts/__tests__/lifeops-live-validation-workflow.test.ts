/**
 * Locks the #11632 manual validation lane to a clean-checkout source graph and
 * a fail-closed evidence artifact. The executable fixture proves that the same
 * shell contract GitHub runs rejects missing permission-matrix results.
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = new URL("../../../", import.meta.url);
const workflowText = readFileSync(
  new URL(".github/workflows/lifeops-live-validation-11632.yml", repoRoot),
  "utf8",
);
const integrationConfig = readFileSync(
  new URL("packages/test/vitest/integration.config.ts", repoRoot),
  "utf8",
);

interface WorkflowStep {
  name?: string;
  uses?: string;
  run?: string;
  with?: Record<string, string | number>;
}

interface WorkflowJob {
  env?: Record<string, string>;
  steps?: WorkflowStep[];
}

interface Workflow {
  jobs?: Record<string, WorkflowJob>;
}

const workflow = Bun.YAML.parse(workflowText) as Workflow;
const job = workflow.jobs?.collect;
const repoRootPath = fileURLToPath(repoRoot);

function namedStep(name: string): WorkflowStep {
  const step = job?.steps?.find((candidate) => candidate.name === name);
  if (!step) throw new Error(`Missing #11632 workflow step: ${name}`);
  return step;
}

function seedStatusArtifact(root: string, matrixLog: string): void {
  for (const phase of ["pre", "post"]) {
    const directory = path.join(root, phase);
    mkdirSync(directory, { recursive: true });
    writeFileSync(path.join(directory, "README.md"), `${phase} status\n`);
    writeFileSync(
      path.join(directory, "status.json"),
      `${JSON.stringify({
        issue: 11632,
        generatedAt: `2026-07-14T00:00:0${phase === "pre" ? "0" : "1"}.000Z`,
        verdict: { closeable: false },
      })}\n`,
    );
  }
  writeFileSync(
    path.join(root, "owner-agent-permission-matrix.txt"),
    matrixLog,
  );
}

function runEvidenceValidation(
  root: string,
  options: { requestedConnectors?: boolean } = {},
) {
  return spawnSync(
    "bash",
    ["-c", namedStep("Validate evidence contract").run ?? ""],
    {
      cwd: repoRootPath,
      encoding: "utf8",
      env: {
        ...process.env,
        LIFEOPS_EVIDENCE_DIR: root,
        RUN_KEYLESS_MATRIX: "true",
        RUN_LIVE_CONNECTORS: String(options.requestedConnectors ?? false),
        GITHUB_SHA: "0123456789abcdef",
        GITHUB_RUN_ID: "1234",
        GITHUB_RUN_ATTEMPT: "1",
      },
    },
  );
}

describe("#11632 LifeOps live-validation workflow", () => {
  test("resolves clean-checkout cloud imports from source before collection", () => {
    expect(integrationConfig).toContain("find: /^@elizaos\\/cloud-routing$/");
    expect(integrationConfig).toContain(
      '"packages",\n  "cloud",\n  "routing",',
    );
    expect(integrationConfig).toContain(
      "find: /^@elizaos\\/plugin-elizacloud$/",
    );
    expect(integrationConfig).toContain('"index.node.ts"');
    expect(integrationConfig).toContain('conditions: ["eliza-source"]');
    expect(integrationConfig).toContain(
      "...buildHarnessSourceAliases(elizaWorkspaceRoot)",
    );
  });

  test("uploads the same report tree populated by both status collectors", () => {
    expect(job?.env?.LIFEOPS_EVIDENCE_DIR).toContain(
      "reports/lifeops-live-validation/11632-status",
    );
    expect(namedStep("Collect pre-run status").run).toContain(
      '"$LIFEOPS_EVIDENCE_DIR/pre/status.json"',
    );
    expect(namedStep("Collect post-run status").run).toContain(
      '"$LIFEOPS_EVIDENCE_DIR/post/status.json"',
    );
    expect(namedStep("Validate evidence contract").run).toBe(
      "node scripts/lifeops/validate-11632-evidence.mjs",
    );
    expect(namedStep("Upload status artifact").with?.path).toBe(
      "reports/lifeops-live-validation/11632-status/",
    );
    expect(
      namedStep("Upload status artifact").with?.["if-no-files-found"],
    ).toBe("error");
  });

  test("accepts a complete 20-pass fixture and emits a hash manifest", () => {
    const root = mkdtempSync(path.join(tmpdir(), "lifeops-11632-workflow-"));
    try {
      seedStatusArtifact(
        root,
        "Test Files  1 passed (1)\nTests  20 passed (20)\n",
      );

      const result = runEvidenceValidation(root);
      expect(result.status).toBe(0);
      const manifest = JSON.parse(
        readFileSync(path.join(root, "artifact-manifest.json"), "utf8"),
      ) as {
        schema: string;
        commit: string;
        artifacts: Array<{ bytes: number; sha256: string }>;
      };
      expect(manifest.schema).toBe("eliza_lifeops_11632_evidence_v1");
      expect(manifest.commit).toBe("0123456789abcdef");
      expect(manifest.artifacts).toHaveLength(5);
      expect(manifest.artifacts.every((artifact) => artifact.bytes > 0)).toBe(
        true,
      );
      expect(
        manifest.artifacts.every((artifact) =>
          /^[a-f0-9]{64}$/.test(artifact.sha256),
        ),
      ).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects an empty or non-passing matrix artifact", () => {
    const root = mkdtempSync(path.join(tmpdir(), "lifeops-11632-workflow-"));
    try {
      seedStatusArtifact(root, "");

      const result = runEvidenceValidation(root);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(
        /Evidence artifact is empty|does not prove exactly 20 passing tests/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects requested connector logs with skipped tests", () => {
    const root = mkdtempSync(path.join(tmpdir(), "lifeops-11632-workflow-"));
    try {
      seedStatusArtifact(
        root,
        "Test Files  1 passed (1)\nTests  20 passed (20)\n",
      );
      for (const filename of ["plugin-google-live.txt", "plugin-x-live.txt"]) {
        writeFileSync(
          path.join(root, filename),
          "Test Files  1 passed (1)\nTests  4 passed | 1 skipped (5)\n",
        );
      }

      const result = runEvidenceValidation(root, {
        requestedConnectors: true,
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("is not skip-free live proof");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
