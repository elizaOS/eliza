/**
 * Lightweight Terraform invariants that do not need provider init.
 *
 * Full `terraform validate` still belongs in CI with initialized providers;
 * these tests catch high-risk drift in plain files during package tests.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const K8S_TERRAFORM_DIR = join(
  import.meta.dir,
  "..",
  "cloud",
  "terraform",
  "gcp",
  "02-k8s",
);

function readK8sTerraform(file: string): string {
  return readFileSync(join(K8S_TERRAFORM_DIR, file), "utf-8");
}

describe("Terraform redis-rest deployment", () => {
  const main = readK8sTerraform("main.tf");

  test("wires Redis auth config into redis-rest connection string", () => {
    expect(main).toContain('name  = "SRH_TOKEN"');
    expect(main).toContain("value = var.redis_config.redis_rest_token");
    expect(main).toContain("var.redis_config.auth_enabled");
    expect(main).toContain("var.redis_config.auth_password");
    expect(main).toContain(
      "redis://:$" +
        "{var.redis_config.auth_password}@redis-master.eliza-infra.svc:6379",
    );
  });

  test("keeps redis-rest pod and container hardening aligned with local manifests", () => {
    expect(main).toContain("security_context");
    expect(main).toContain("run_as_non_root = true");
    expect(main).toContain("run_as_user     = 10001");
    expect(main).toContain("run_as_group    = 10001");
    expect(main).toContain("fs_group        = 10001");
    expect(main).toContain("read_only_root_filesystem  = true");
    expect(main).toContain("allow_privilege_escalation = false");
    expect(main).toContain('drop = ["ALL"]');
    expect(main).toContain('type = "RuntimeDefault"');
  });
});

describe("Terraform namespace contracts", () => {
  test("documents that database cluster keys are Kubernetes namespaces", () => {
    const variables = readK8sTerraform("variables.tf");

    expect(variables).toContain(
      'description = "List of Kubernetes namespaces to create"',
    );
    expect(variables).toContain(
      'description = "CNPG PostgreSQL clusters to deploy (key = namespace/org UUID)"',
    );
  });
});
