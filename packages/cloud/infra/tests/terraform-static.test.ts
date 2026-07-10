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
const CLOUDFLARE_PAGES_DOMAINS_DIR = join(
  import.meta.dir,
  "..",
  "cloud",
  "terraform",
  "cloudflare",
  "pages-domains",
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

describe("Apps tenant-DB connection scaling (#8321 P0 #2)", () => {
  const HETZNER_APPS_SHARED = join(
    import.meta.dir,
    "..",
    "cloud",
    "terraform",
    "hetzner",
    "apps-shared",
  );
  const tenantDbInit = readFileSync(
    join(HETZNER_APPS_SHARED, "cloud-init", "tenant-db.yaml.tftpl"),
    "utf-8",
  );
  const mainTf = readFileSync(join(HETZNER_APPS_SHARED, "main.tf"), "utf-8");
  const outputsTf = readFileSync(
    join(HETZNER_APPS_SHARED, "outputs.tf"),
    "utf-8",
  );

  test("raises the Postgres connection ceiling above the default 100", () => {
    expect(tenantDbInit).toContain("max_connections = 500");
    // shared_buffers is RAM-derived (25% of MemTotal) — assert the sed wires it.
    expect(tenantDbInit).toContain("shared_buffers = $SHARED_BUF");
  });

  test("installs pgbouncer and runs it in SESSION pool mode on :6432", () => {
    expect(tenantDbInit).toContain("- pgbouncer");
    expect(tenantDbInit).toContain("listen_port = 6432");
    // SESSION (not transaction) — plugin-sql's migrator holds session-scoped
    // advisory locks across pool checkouts; transaction pooling would orphan them.
    expect(tenantDbInit).toContain("pool_mode = session");
    expect(tenantDbInit).toContain("auth_type = scram-sha-256");
    expect(tenantDbInit).toContain(
      "auth_query = SELECT usename, passwd FROM public.pgbouncer_user_lookup($1)",
    );
    // auth_user resolves per-tenant SCRAM via a SECURITY DEFINER lookup, not superuser.
    expect(tenantDbInit).toContain("SECURITY DEFINER");
    expect(tenantDbInit).toContain(
      "GRANT EXECUTE ON FUNCTION public.pgbouncer_user_lookup",
    );
  });

  test("threads a stable pgbouncer auth credential through terraform", () => {
    expect(mainTf).toContain('resource "random_password" "pgbouncer_auth"');
    expect(mainTf).toContain(
      "pgbouncer_auth_password = random_password.pgbouncer_auth.result",
    );
  });

  test("exposes the pooler endpoint operators set as the app-facing cluster host", () => {
    expect(outputsTf).toContain('output "tenant_db_pooler_endpoint"');
    expect(outputsTf).toContain(
      'value       = "${cidrhost(var.subnet_cidr, 10)}:6432"',
    );
    // The admin/DDL DSN must stay on :5432 (never through the pooler).
    expect(outputsTf).toContain(":5432/postgres?sslmode=require");
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

describe("Cloudflare Pages domain durability", () => {
  const main = readFileSync(
    join(CLOUDFLARE_PAGES_DOMAINS_DIR, "main.tf"),
    "utf-8",
  );
  const imports = readFileSync(
    join(CLOUDFLARE_PAGES_DOMAINS_DIR, "import.tf"),
    "utf-8",
  );
  const variables = readFileSync(
    join(CLOUDFLARE_PAGES_DOMAINS_DIR, "variables.tf"),
    "utf-8",
  );
  const workflow = readFileSync(
    join(
      import.meta.dir,
      "../../../../.github/workflows/terraform-pages-domains.yml",
    ),
    "utf-8",
  );

  test("binds production and staging to distinct Pages branch aliases", () => {
    expect(main).toContain('domain       = "elizacloud.ai"');
    expect(main).toContain('domain       = "app.elizacloud.ai"');
    expect(main).toContain('domain       = "staging.elizacloud.ai"');
    expect(main).toContain('domain       = "app-staging.elizacloud.ai"');
    expect(main).toContain('cname_target = "develop.eliza-cloud.pages.dev"');
    expect(main).toContain('cname_target = "develop.eliza-app.pages.dev"');
    expect(main).toContain('resource "cloudflare_pages_domain" "public"');
    expect(main).toContain('resource "cloudflare_dns_record" "pages"');
  });

  test("adopts live bindings and exact-name DNS records before managing them", () => {
    expect(imports).toContain('data "cloudflare_dns_records" "existing_pages"');
    expect(imports).toContain("exact = each.value.domain");
    expect(imports).toContain("cloudflare_pages_domain.public[each.key]");
    expect(imports).toContain("cloudflare_dns_record.pages[each.key]");
    expect(imports).toContain(
      "one(data.cloudflare_dns_records.existing_pages[each.key].result).id",
    );
  });

  test("owns the staging dedicated-agent wildcard and paid certificate pack", () => {
    expect(main).toContain(
      'resource "cloudflare_dns_record" "staging_agent_wildcard"',
    );
    expect(main).toContain('name    = "*.staging.elizacloud.ai"');
    expect(main).toContain(
      'resource "cloudflare_certificate_pack" "staging_agent"',
    );
    expect(main).toContain('type                  = "advanced"');
    expect(main).toContain("prevent_destroy       = true");
    expect(imports).toContain(
      'data "cloudflare_dns_records" "existing_staging_agent_wildcard"',
    );
    expect(imports).toContain("cloudflare_certificate_pack.staging_agent[0]");
    expect(variables).toContain('variable "staging_agent_wildcard_origins"');
    expect(variables).toContain('variable "staging_agent_certificate_pack_id"');
    expect(workflow).toContain("STAGING_AGENT_WILDCARD_ORIGINS_JSON");
    expect(workflow).toContain("STAGING_AGENT_CERTIFICATE_PACK_ID");
    expect(workflow).toContain("terraform-probe.staging.elizacloud.ai");
  });

  test("keeps real writes manual and verifies certificate plus routing after apply", () => {
    expect(workflow).toContain("oven-sh/setup-bun@");
    expect(workflow).toContain(
      "bun install --frozen-lockfile --ignore-scripts",
    );
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).toContain("options: [plan, apply]");
    expect(workflow).toContain("terraform apply -no-color -input=false");
    expect(workflow).toContain('entry.status !== "active"');
    expect(workflow).toContain("--require-beacon");
    expect(workflow).not.toContain("push:");
  });
});
