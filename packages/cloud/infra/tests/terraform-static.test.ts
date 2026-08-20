/**
 * Lightweight Terraform invariants that do not need provider init.
 *
 * Full `terraform validate` still belongs in CI with initialized providers;
 * these tests catch high-risk drift in plain files during package tests.
 */

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
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
const PROD_OPS_DIR = join(
  import.meta.dir,
  "..",
  "cloud",
  "terraform",
  "hetzner",
  "prod-ops",
);
const HETZNER_CONTROL_PLANE_DIR = join(
  import.meta.dir,
  "..",
  "cloud",
  "terraform",
  "hetzner",
  "control-plane",
);
const HETZNER_APPS_SHARED_DIR = join(
  import.meta.dir,
  "..",
  "cloud",
  "terraform",
  "hetzner",
  "apps-shared",
);

function readK8sTerraform(file: string): string {
  return readFileSync(join(K8S_TERRAFORM_DIR, file), "utf-8");
}

function terraformResource(source: string, type: string, name: string): string {
  const declaration = `resource "${type}" "${name}"`;
  const declarationStart = source.indexOf(declaration);
  expect(declarationStart).toBeGreaterThanOrEqual(0);

  const blockStart = source.indexOf("{", declarationStart);
  expect(blockStart).toBeGreaterThan(declarationStart);

  let depth = 0;
  for (let index = blockStart; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") depth -= 1;
    if (depth === 0) return source.slice(blockStart + 1, index);
  }

  throw new Error(`Unclosed Terraform resource: ${type}.${name}`);
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

describe("Protected production-operations runner", () => {
  const main = readFileSync(join(PROD_OPS_DIR, "main.tf"), "utf-8");
  const variables = readFileSync(join(PROD_OPS_DIR, "variables.tf"), "utf-8");
  const cloudInit = readFileSync(
    join(PROD_OPS_DIR, "cloud-init", "bootstrap.yaml.tftpl"),
    "utf-8",
  );
  const readme = readFileSync(join(PROD_OPS_DIR, "README.md"), "utf-8");

  test("creates two replaceable slots outside public CI and agent planes", () => {
    expect(main).toContain("for index in range(var.runner_count)");
    expect(main).toContain('"prod-ops-$' + '{index + 1}"');
    expect(main).toContain('"runner-slot" = each.value.slot');
    expect(main).toContain('"role"        = "github-actions-prod-ops"');
    expect(main).toContain("bootstrap_revision");
    expect(main).toContain("create_before_destroy = true");
    expect(main).not.toContain("prevent_destroy");
    expect(main).not.toContain("ignore_changes");
    expect(main).toContain('port        = "22"');
    expect(main).not.toContain('"0.0.0.0/0"');
    expect(main).not.toContain('"::/0"');
    expect(variables).toContain('var.environment == "production"');
    expect(variables).toContain('cidr != "0.0.0.0/0"');
    expect(variables).toContain('cidr != "::/0"');
    expect(variables).toContain("default     = 2");
    expect(variables).toContain("var.runner_count >= 2");
  });

  test("pins immutable one-job runner bytes and keeps credentials out of state", () => {
    expect(cloudInit).toContain("actions-runner-linux-x64-2.336.0.tar.gz");
    expect(cloudInit).toContain(
      "04cf0be1aff4c3ec3554466c39124ca250e3effd8873bb7e8d68535aa9505d5d",
    );
    expect(cloudInit).toContain("IFS= read -r registration_token");
    expect(cloudInit).toContain("--ephemeral");
    expect(cloudInit).toContain("--disableupdate");
    expect(cloudInit).toContain("--runnergroup prod-ops");
    expect(cloudInit).toContain("--labels $" + "{runner_slot},hetzner-cloud");
    expect(cloudInit).toContain("ExecStart=/opt/actions-runner/runsvc.sh");
    expect(cloudInit).toContain("Restart=no");
    expect(cloudInit).toContain("KillMode=control-group");
    expect(cloudInit).toContain("NoNewPrivileges=true");
    expect(cloudInit).toContain("ReadOnlyPaths=/opt/actions-runner");
    expect(cloudInit).toContain(
      "ReadWritePaths=/var/lib/eliza-prod-ops-runner",
    );
    expect(cloudInit).not.toContain("ACTIONS_RUNNER_HOOK_JOB_COMPLETED");
    expect(cloudInit).toContain("ExecStopPost=+");
    expect(cloudInit).toContain("prod-ops-reset-state");
    expect(main).not.toMatch(/github.*token|registration.*token/i);
    expect(variables).not.toMatch(/github.*token|registration.*token/i);
  });

  test("documents exact workflow and human approval restrictions", () => {
    expect(readme).toContain("refs/heads/main");
    expect(readme).toContain("restricted_to_workflows=true");
    expect(readme).toContain("prod-ops-runner.yml@refs/heads/main");
    expect(readme).not.toContain("slophub-cutover.yml@refs/heads/main");
    expect(readme).not.toContain("infra.yml@refs/heads/main");
    expect(readme).toContain("production");
    expect(readme).toContain("two live doctor passes");
    expect(readme).toContain("switch back to");
    expect(readme).toContain("`ubuntu-24.04`");
  });
});

describe("Persistent Hetzner resource safeguards", () => {
  const controlPlane = readFileSync(
    join(HETZNER_CONTROL_PLANE_DIR, "main.tf"),
    "utf-8",
  );
  const appsShared = readFileSync(
    join(HETZNER_APPS_SHARED_DIR, "main.tf"),
    "utf-8",
  );

  test("protects and backs up persistent control-plane servers", () => {
    const server = terraformResource(
      controlPlane,
      "hcloud_server",
      "control_plane",
    );

    expect(server).toContain("backups            = true");
    expect(server).toContain("delete_protection  = true");
    expect(server).toContain("rebuild_protection = true");
    expect(server).toContain("prevent_destroy = true");
  });

  test("attaches every control plane to its protected private network", () => {
    const network = terraformResource(
      controlPlane,
      "hcloud_network",
      "data_plane",
    );
    const attachment = terraformResource(
      controlPlane,
      "hcloud_server_network",
      "control_plane",
    );

    expect(network).toContain("delete_protection = true");
    expect(network).toContain("prevent_destroy = true");
    expect(attachment).toContain("for_each = hcloud_server.control_plane");
    expect(attachment).toContain("server_id = each.value.id");
    expect(attachment).toContain(
      "subnet_id = hcloud_network_subnet.data_plane.id",
    );
    expect(attachment).not.toContain("network_id =");
  });

  test("protects and backs up the shared tenant database failure domain", () => {
    const network = terraformResource(appsShared, "hcloud_network", "apps");
    const volume = terraformResource(
      appsShared,
      "hcloud_volume",
      "tenant_db_data",
    );
    const server = terraformResource(appsShared, "hcloud_server", "tenant_db");

    expect(network).toContain("delete_protection = true");
    expect(network).toContain("prevent_destroy = true");
    expect(volume).toContain("delete_protection = true");
    expect(volume).toContain("prevent_destroy = true");
    expect(server).toContain("backups            = true");
    expect(server).toContain("delete_protection  = true");
    expect(server).toContain("rebuild_protection = true");
    expect(server).toContain("prevent_destroy = true");
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
  const outputs = readFileSync(
    join(CLOUDFLARE_PAGES_DOMAINS_DIR, "outputs.tf"),
    "utf-8",
  );
  const readme = readFileSync(
    join(CLOUDFLARE_PAGES_DOMAINS_DIR, "README.md"),
    "utf-8",
  );
  const stagingExample = readFileSync(
    join(CLOUDFLARE_PAGES_DOMAINS_DIR, "tfvars", "staging.tfvars.example"),
    "utf-8",
  );
  const productionExample = readFileSync(
    join(CLOUDFLARE_PAGES_DOMAINS_DIR, "tfvars", "production.tfvars.example"),
    "utf-8",
  );
  const workflow = readFileSync(
    join(import.meta.dir, "../../../../.github/workflows/infra.yml"),
    "utf-8",
  );
  const inventoryValidator = workflow.match(
    /node -e '\n([\s\S]*?)\n\s+'\n/,
  )?.[1];

  function validateInventory(
    overrides: Record<string, string> = {},
  ): ReturnType<typeof spawnSync> {
    if (!inventoryValidator) {
      throw new Error("Pages inventory validator was not found in infra.yml");
    }
    return spawnSync("node", ["-e", inventoryValidator], {
      env: {
        ...process.env,
        TF_VAR_dns_record_import_ids: '{"record":"id"}',
        TF_VAR_canonical_edge_wildcard_origins: '["192.0.2.1"]',
        TF_VAR_canonical_service_origins: '{"api.example":["192.0.2.2"]}',
        TF_VAR_railway_tunnel_dns_records: "{}",
        TF_VAR_canonical_edge_certificate_packs:
          '{"canonical":{"hosts":["example"]}}',
        TF_VAR_legacy_redirect_wildcard_origins:
          '{"*.legacy.example":["192.0.2.3"]}',
        TF_VAR_legacy_redirect_certificate_packs:
          '{"legacy":{"hosts":["legacy.example"]}}',
        ...overrides,
      },
      encoding: "utf8",
    });
  }

  test("binds every canonical browser host to one Pages project", () => {
    expect(main).toContain('domain       = "eliza.app"');
    expect(main).toContain('domain       = "cloud.eliza.app"');
    expect(main).toContain('domain       = "www.eliza.app"');
    expect(main).toContain('domain       = "staging.eliza.app"');
    expect(main).toContain('domain       = "cloud-staging.eliza.app"');
    expect(main).toContain('cname_target = "develop.eliza-app.pages.dev"');
    expect(main).not.toContain('project_name = "eliza-cloud"');
    expect(main).toContain('resource "cloudflare_pages_domain" "public"');
    expect(main).toContain('resource "cloudflare_dns_record" "pages"');
    expect(readme).toContain("custom branch aliases");
  });

  test("adopts canonical and legacy DNS only through explicit record ids", () => {
    expect(variables).toContain('variable "dns_record_import_ids"');
    expect(imports).not.toContain('data "cloudflare_dns_records"');
    expect(imports).toContain(
      'lookup(var.dns_record_import_ids, "pages/${key}", "")',
    );
    expect(imports).toContain("cloudflare_dns_record.pages[each.key]");
    expect(imports).toContain("local.canonical_edge_dns_imports");
    expect(imports).toContain("local.legacy_edge_dns_imports");
    expect(readme).toContain("Omit a key only when");
  });

  test("adopts pre-attached canonical Pages bindings deterministically", () => {
    expect(imports).toContain(
      "pages_domain_imports = local.canonical_pages_domains",
    );
    expect(imports).toContain("cloudflare_pages_domain.public[each.key]");
    expect(imports).toContain(
      `\${var.cloudflare_account_id}/\${each.value.project_name}/\${each.value.domain}`,
    );
    expect(readme).toContain("configuration-driven imports");
  });

  test("owns canonical agent and site wildcard DNS plus additive certificates", () => {
    expect(main).toContain('"*.cloud.eliza.app"');
    expect(main).toContain('"*.sites.eliza.app"');
    expect(main).toContain('"*.cloud-staging.eliza.app"');
    expect(main).toContain('"*.sites-staging.eliza.app"');
    expect(main).toContain(
      'resource "cloudflare_dns_record" "canonical_edge_wildcard"',
    );
    expect(main).toContain(
      'resource "cloudflare_certificate_pack" "canonical_edge"',
    );
    expect(main).toContain('type                  = "advanced"');
    expect(main).toContain("prevent_destroy = true");
    expect(main).not.toMatch(/^\s*cloudflare_branding\s*=/m);
    expect(readme).toContain("Leave `cloudflare_branding` unset");
    expect(variables).toContain('variable "canonical_edge_wildcard_origins"');
    expect(variables).toContain('variable "canonical_edge_certificate_packs"');
    expect(imports).toContain(
      "cloudflare_certificate_pack.canonical_edge[each.key]",
    );
    expect(outputs).toContain('output "canonical_edge"');
  });

  test("owns proxied DNS for every exact canonical Worker service", () => {
    for (const hostname of [
      "api.eliza.app",
      "blob.eliza.app",
      "plugins.eliza.app",
      "relay.eliza.app",
      "x402.eliza.app",
      "api-staging.eliza.app",
      "blob-staging.eliza.app",
      "plugins-staging.eliza.app",
      "relay-staging.eliza.app",
      "x402-staging.eliza.app",
    ]) {
      expect(variables).toContain(hostname);
    }
    expect(main).toContain(
      'resource "cloudflare_dns_record" "canonical_service"',
    );
    expect(variables).toContain('variable "canonical_service_origins"');
    expect(imports).toContain("local.canonical_service_dns_imports");
    expect(imports).toContain(
      "cloudflare_dns_record.canonical_service[each.key]",
    );
  });

  test("examples enumerate relay import ids alongside relay origins", () => {
    expect(productionExample).toContain('"pages/legacy_relay"');
    expect(productionExample).toContain(
      '"canonical-service/relay.eliza.app|<first-reviewed-origin-ipv4>"',
    );
    expect(stagingExample).toContain('"pages/legacy_relay"');
    expect(stagingExample).toContain(
      '"canonical-service/relay-staging.eliza.app|<first-current-origin-ipv4>"',
    );
  });

  test("owns reviewed Railway tunnel DNS as an imported DNS-only inventory", () => {
    expect(variables).toContain('variable "railway_tunnel_dns_records"');
    expect(variables).toContain(
      "length(var.railway_tunnel_dns_records) == 0 || (",
    );
    expect(variables).toContain('"apex-routing"');
    expect(variables).toContain('"apex-verification"');
    expect(variables).toContain('"wildcard-routing"');
    expect(variables).toContain('"wildcard-certificate"');
    expect(variables).toContain('"wildcard-verification"');
    expect(main).toContain('resource "cloudflare_dns_record" "railway_tunnel"');
    expect(main).toContain("for_each = var.railway_tunnel_dns_records");
    expect(main).toContain("proxied = false");
    expect(variables).toContain("roles   = set(string)");
    expect(variables).toContain("length(distinct([");
    expect(imports).toContain('"railway-tunnel/$' + '{key}"');
    expect(imports).toContain("cloudflare_dns_record.railway_tunnel[each.key]");
    expect(outputs).toContain('output "railway_tunnel_dns"');
    expect(outputs).toContain(
      "roles   = var.railway_tunnel_dns_records[key].roles",
    );
    for (const example of [stagingExample, productionExample]) {
      expect(example).toContain('"railway-tunnel/shared-verification"');
      expect(example).toContain(
        'roles   = ["apex-verification", "wildcard-verification"]',
      );
    }
    expect(readme).toContain("RAILWAY_TUNNEL_DNS_RECORDS_JSON");
    expect(readme).toContain("deduplicates a");
    expect(readme).toContain("no paid Cloudflare certificate dependency");
  });

  test("keeps legacy redirect ingress explicit and preserves the live staging pack", () => {
    for (const hostname of [
      "elizacloud.ai",
      "app.elizacloud.ai",
      "www.elizacloud.ai",
      "docs.elizacloud.ai",
      "api.elizacloud.ai",
      "plugins.elizacloud.ai",
      "relay.elizacloud.ai",
      "x402.elizacloud.ai",
    ]) {
      expect(main).toContain(hostname);
    }
    expect(variables).toContain('"*.sites.elizacloud.ai"');
    expect(variables).toContain('"*.tunnel.elizacloud.ai"');
    expect(main).toContain(
      'resource "cloudflare_dns_record" "staging_agent_wildcard"',
    );
    expect(main).toContain('name    = "*.staging.elizacloud.ai"');
    expect(main).toContain(
      'resource "cloudflare_certificate_pack" "staging_agent"',
    );
    expect(main).toContain(
      'resource "cloudflare_certificate_pack" "legacy_redirect"',
    );
    expect(imports).toContain("cloudflare_certificate_pack.staging_agent[0]");
    expect(variables).toContain('variable "legacy_redirect_wildcard_origins"');
    expect(variables).toContain('variable "legacy_redirect_certificate_packs"');
    expect(outputs).toContain('output "redirect_dns"');
  });

  test("relinquishes R2-owned legacy blob DNS without destroying live records", () => {
    expect(main).not.toContain("legacy_blob = {");
    expect(stagingExample).not.toContain('"pages/legacy_blob"');
    expect(productionExample).not.toContain('"pages/legacy_blob"');
    expect(readme).toContain("Cloudflare R2 owns");
    expect(readme).toContain("`blob.elizacloud.ai`");
    expect(readme).toContain("`blob-staging.elizacloud.ai`");
    expect(readme).toContain("operators must leave both live records in R2");
    expect(readme).toContain("`operation=state-rm`");
    expect(readme).toContain('`cloudflare_dns_record.pages["legacy_blob"]`');
    expect(workflow).toContain('terraform state rm "$STATE_ADDRESS"');
  });

  test("keeps real writes manual and verifies certificate plus routing after apply", () => {
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).toContain("options: [plan, apply, state-rm]");
    expect(workflow).toContain("terraform apply -no-color -input=false");
    expect(workflow).toContain(
      'canonical.certificate_packs?.[key]?.status !== "active"',
    );
    expect(workflow).toContain(
      "TF_VAR_railway_tunnel_dns_records: $" +
        "{{ vars.RAILWAY_TUNNEL_DNS_RECORDS_JSON || '{}' }}",
    );
    expect(workflow).toContain(
      '["RAILWAY_TUNNEL_DNS_RECORDS_JSON", process.env.TF_VAR_railway_tunnel_dns_records, "object", true]',
    );
    expect(workflow).toContain(
      "for (const [name, source, expected, allowEmpty = false] of required)",
    );
    expect(workflow).toContain("allowEmpty || Object.keys(value).length > 0");
    expect(workflow).toContain("terraform output -json railway_tunnel_dns");
    // The record-shape checks moved from inline workflow script into the
    // dedicated validator the workflow invokes after apply.
    expect(workflow).toContain("validate-terraform-pages-domain-state.mjs");
    const validator = readFileSync(
      join(
        import.meta.dir,
        "../../../../packages/scripts/validate-terraform-pages-domain-state.mjs",
      ),
      "utf-8",
    );
    expect(validator).toContain("record?.proxied !== false");
    expect(validator).toContain("record?.roles?.includes(role)");
    expect(workflow).toContain("--require-beacon");
    expect(workflow).not.toContain("bun install");
    expect(workflow).not.toContain("push:");
  });

  test("accepts an empty Railway inventory without weakening required inventories", () => {
    expect(validateInventory().status).toBe(0);

    const missingCanonicalServices = validateInventory({
      TF_VAR_canonical_service_origins: "{}",
    });
    expect(missingCanonicalServices.status).toBe(1);
    expect(missingCanonicalServices.stderr).toContain(
      "CANONICAL_SERVICE_ORIGINS_JSON",
    );
  });
});
