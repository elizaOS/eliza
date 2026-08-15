/**
 * Executes the Infrastructure workflow's additive-plan validator against
 * deterministic Terraform JSON fixtures without contacting a backend.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

interface WorkflowStep {
  name?: string;
  run?: string;
}

interface Workflow {
  jobs?: { terraform?: { steps?: WorkflowStep[] } };
}

const repoRoot = new URL("../../../", import.meta.url);
const workflow = Bun.YAML.parse(
  await Bun.file(new URL(".github/workflows/infra.yml", repoRoot)).text(),
) as Workflow;
const validator = workflow.jobs?.terraform?.steps?.find(
  (step) => step.name === "Validate additive canonical edge plan",
)?.run;

if (!validator) {
  throw new Error("Infrastructure workflow has no additive-plan validator");
}

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

function resource(
  address: string,
  actions: string[],
  options: { importing?: { id: string } } = {},
) {
  return { address, mode: "managed", change: { actions, ...options } };
}

function runValidator(resourceChanges: ReturnType<typeof resource>[]) {
  const directory = mkdtempSync(join(tmpdir(), "terraform-additive-plan-"));
  temporaryDirectories.push(directory);
  const fixturePath = join(directory, "plan.json");
  const terraformPath = join(directory, "terraform");
  writeFileSync(
    fixturePath,
    JSON.stringify({ resource_changes: resourceChanges }),
  );
  writeFileSync(
    terraformPath,
    '#!/usr/bin/env bash\nset -euo pipefail\n[ "$1" = "show" ]\ncat "$PLAN_FIXTURE"\n',
  );
  chmodSync(terraformPath, 0o700);
  return Bun.spawnSync(["bash", "-c", validator], {
    cwd: directory,
    env: {
      ...process.env,
      PATH: `${directory}:${process.env.PATH ?? ""}`,
      PLAN_FIXTURE: fixturePath,
      RUNNER_TEMP: directory,
      TARGET_ENVIRONMENT: "staging",
    },
    stderr: "pipe",
    stdout: "pipe",
  });
}

describe("canonical-edge additive Terraform plan workflow", () => {
  const certificate =
    'cloudflare_certificate_pack.canonical_edge["generation-2"]';
  const siteDns =
    'cloudflare_dns_record.canonical_edge_wildcard["*.sites-staging.eliza.app|203.0.113.10"]';

  test("accepts only create/no-op changes in the reviewed resource families", () => {
    const result = runValidator([
      resource(certificate, ["create"]),
      resource(siteDns, ["no-op"]),
    ]);
    expect(result.exitCode).toBe(0);
  });

  test.each([
    ["update", resource(siteDns, ["update"])],
    ["replacement", resource(certificate, ["delete", "create"])],
    [
      "out-of-scope creation",
      resource('cloudflare_dns_record.pages["marketing"]', ["create"]),
    ],
    [
      "in-scope import",
      resource(siteDns, ["no-op"], { importing: { id: "existing-record" } }),
    ],
    [
      "out-of-scope import",
      resource('cloudflare_dns_record.pages["marketing"]', ["no-op"], {
        importing: { id: "existing-record" },
      }),
    ],
  ])("rejects %s", (_label, invalidChange) => {
    const result = runValidator([
      resource(certificate, ["create"]),
      resource(siteDns, ["no-op"]),
      invalidChange,
    ]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("not additive-only");
  });

  test("rejects a vacuous target set with no creation", () => {
    const result = runValidator([
      resource(certificate, ["no-op"]),
      resource(siteDns, ["no-op"]),
    ]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain(
      "scope contains no additive resource creation",
    );
  });
});
