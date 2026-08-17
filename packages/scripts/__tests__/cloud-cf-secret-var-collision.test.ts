/**
 * Guards the Worker secret/var namespace: Cloudflare rejects `wrangler secret
 * put NAME` with error 10053 when the served Worker version already defines
 * NAME as a plain [vars] binding. This collision class caused two live
 * incidents (CARTESIA_API_KEY at launch; PERSONAL_SHARED_TELEGRAM_EDGE_ENABLED
 * on the 2026-08-16 staging edge flip). Every workflow-published secret is
 * enumerated here with the environments it targets; the test fails when
 * wrangler.toml defines the same name as a var for a targeted environment —
 * and when a new `secret put` appears in a workflow without a mapping entry.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";

const repoRoot = new URL("../../../", import.meta.url);
const wranglerSource = readFileSync(
  new URL("packages/cloud/api/wrangler.toml", repoRoot),
  "utf8",
);
const releaseWorkflowSource = readFileSync(
  new URL(".github/workflows/cloud-cf-release.yml", repoRoot),
  "utf8",
);

/** Parse var names per environment from wrangler.toml ("default" = top-level [vars]). */
function parseWranglerVars(source: string): Map<string, Set<string>> {
  const envs = new Map<string, Set<string>>();
  let current: string | null = null;
  for (const rawLine of source.split("\n")) {
    const line = rawLine.trim();
    const section = line.match(/^\[(?:env\.([a-z0-9_-]+)\.)?vars\]$/);
    if (section) {
      current = section[1] ?? "default";
      if (!envs.has(current)) envs.set(current, new Set());
      continue;
    }
    if (/^\[/.test(line)) {
      current = null;
      continue;
    }
    if (current) {
      const assignment = line.match(/^([A-Z][A-Z0-9_]+)\s*=/);
      if (assignment) envs.get(current)?.add(assignment[1]);
    }
  }
  return envs;
}

/**
 * Workflow-published Worker secrets and the environments whose Worker script
 * they target. Adding a new `wrangler secret put` to any workflow requires a
 * row here — the discovery assertion below fails otherwise.
 */
const PUBLISHED_WORKER_SECRETS: Array<{ name: string; envs: string[] }> = [
  // cloud-cf-release.yml publish_secret / publish_toggle_secret chain
  { name: "CARTESIA_API_KEY", envs: ["staging", "production"] },
  { name: "STAGING_SESSION_EXCHANGE_ENABLED", envs: ["staging"] },
  // The staging cutover uses a fresh secret name because keep_vars preserved
  // the legacy plaintext binding on the served Worker (run 31970252094).
  { name: "PERSONAL_SHARED_TELEGRAM_EDGE_CUTOVER_ENABLED", envs: ["staging"] },
  // The production cutover has a separate environment-pinned secret name. It
  // is reserved here before activation so a future tracked var cannot collide
  // with the protected workflow's secret mutation.
  {
    name: "PERSONAL_SHARED_TELEGRAM_EDGE_CUTOVER_PRODUCTION_ENABLED",
    envs: ["production"],
  },
  // Self-hosted TEI sidecar bearer key, published by cloud-cf-release; must
  // never appear as a [vars] entry anywhere.
  { name: "LOCAL_EMBEDDINGS_API_KEY", envs: ["staging"] },
];

function findUnmappedWorkflowSecretNames(
  source: string,
  mapped: ReadonlySet<string>,
): string[] {
  const unmapped = new Set<string>();
  for (const match of source.matchAll(
    /secret\s+put\s+"?\$?\{?\{?\s*([A-Z][A-Z0-9_]+)/g,
  )) {
    const token = match[1];
    // Resolve trusted selector variables such as EDGE_SECRET_NAME through
    // their quoted literal alternatives. This preserves discovery for
    // environment-selected names instead of treating the selector itself as a
    // Worker binding or silently exempting it.
    const selector = source.match(new RegExp(`^\\s*${token}:\\s*(.+)$`, "m"));
    const selectedNames = selector
      ? [...selector[1].matchAll(/["']([A-Z][A-Z0-9_]+)["']/g)].map(
          (selected) => selected[1],
        )
      : [];
    if (selectedNames.length > 0) {
      for (const selectedName of selectedNames) {
        if (!mapped.has(selectedName)) unmapped.add(selectedName);
      }
      continue;
    }
    if (token === "SECRET_NAME" || token === "GITHUB" || token === "INPUT") {
      continue;
    }
    if (!mapped.has(token)) unmapped.add(token);
  }
  for (const match of source.matchAll(
    /SECRET_NAME:\s*"?([A-Z][A-Z0-9_]+)"?/g,
  )) {
    if (!mapped.has(match[1])) unmapped.add(match[1]);
  }
  return [...unmapped].sort();
}

describe("Worker secret/var collision lint (CF error 10053 class)", () => {
  const vars = parseWranglerVars(wranglerSource);

  test("wrangler.toml parses at least default and staging var blocks", () => {
    expect(vars.has("default")).toBe(true);
    expect(vars.has("staging")).toBe(true);
    expect((vars.get("default") ?? new Set()).size).toBeGreaterThan(3);
  });

  test("no workflow-published secret name is defined as a wrangler var in a targeted environment", () => {
    const collisions: string[] = [];
    for (const { name, envs } of PUBLISHED_WORKER_SECRETS) {
      for (const env of envs) {
        if (vars.get(env)?.has(name)) {
          collisions.push(`${name} → [env.${env}.vars]`);
        }
      }
    }
    expect(collisions).toEqual([]);
  });

  test("every `wrangler secret put` in workflows has a mapping entry", () => {
    const workflowsDir = new URL(".github/workflows/", repoRoot);
    const mapped = new Set(PUBLISHED_WORKER_SECRETS.map((s) => s.name));
    const unmapped = new Set<string>();
    for (const file of readdirSync(workflowsDir)) {
      if (!file.endsWith(".yml") && !file.endsWith(".yaml")) continue;
      const source = readFileSync(new URL(file, workflowsDir), "utf8");
      for (const name of findUnmappedWorkflowSecretNames(source, mapped)) {
        unmapped.add(name);
      }
    }
    expect([...unmapped].sort()).toEqual([]);
  });

  test("resolves environment-selected secret names without exempting unknown literals", () => {
    const selectedWorkflow = [
      "env:",
      "  EDGE_SECRET_NAME: $" +
        "{{ inputs.environment == 'production' && 'PRODUCTION_EDGE_SECRET' || 'STAGING_EDGE_SECRET' }}",
      'run: wrangler secret put "$EDGE_SECRET_NAME"',
    ].join("\n");
    expect(
      findUnmappedWorkflowSecretNames(
        selectedWorkflow,
        new Set(["PRODUCTION_EDGE_SECRET", "STAGING_EDGE_SECRET"]),
      ),
    ).toEqual([]);
    expect(
      findUnmappedWorkflowSecretNames(
        selectedWorkflow,
        new Set(["STAGING_EDGE_SECRET"]),
      ),
    ).toEqual(["PRODUCTION_EDGE_SECRET"]);
  });

  test("keeps production fail-closed while reserving its cutover secret namespace", () => {
    // Production's tracked legacy binding stays explicitly false. Its fresh
    // environment-pinned cutover name must remain absent from every vars block
    // so the protected workflow can own it as a secret without CF error 10053.
    expect(
      vars.get("production")?.has("PERSONAL_SHARED_TELEGRAM_EDGE_ENABLED") ??
        false,
    ).toBe(true);
    for (const names of vars.values()) {
      expect(
        names.has("PERSONAL_SHARED_TELEGRAM_EDGE_CUTOVER_PRODUCTION_ENABLED"),
      ).toBe(false);
    }
  });

  test("configures authenticated local embeddings only in staging", () => {
    const config = Bun.TOML.parse(wranglerSource) as {
      vars?: { LOCAL_EMBEDDINGS_BASE_URL?: string };
      env?: {
        staging?: { vars?: { LOCAL_EMBEDDINGS_BASE_URL?: string } };
        production?: { vars?: { LOCAL_EMBEDDINGS_BASE_URL?: string } };
      };
    };

    expect(config.vars?.LOCAL_EMBEDDINGS_BASE_URL).toBeUndefined();
    expect(config.env?.staging?.vars?.LOCAL_EMBEDDINGS_BASE_URL).toBe(
      "https://embeddings-staging-staging.up.railway.app",
    );
    expect(
      config.env?.production?.vars?.LOCAL_EMBEDDINGS_BASE_URL,
    ).toBeUndefined();
    for (const [environment, names] of vars) {
      expect(
        names.has("LOCAL_EMBEDDINGS_API_KEY"),
        `${environment} must not publish LOCAL_EMBEDDINGS_API_KEY as plaintext`,
      ).toBe(false);
    }
    expect(releaseWorkflowSource).toContain(
      "LOCAL_EMBEDDINGS_API_KEY: $" +
        "{{ steps.env.outputs.deploy_environment == 'staging' && secrets.LOCAL_EMBEDDINGS_API_KEY || '' }}",
    );
    expect(releaseWorkflowSource).toContain(
      'LOCAL_EMBEDDINGS_API_KEY)\n                if [ "$DEPLOY_ENVIRONMENT" != "staging" ]; then',
    );
    expect(releaseWorkflowSource).toContain(
      'if (!available.has("LOCAL_EMBEDDINGS_API_KEY"))',
    );
    expect(releaseWorkflowSource).toContain(
      'required.push("LOCAL_EMBEDDINGS_API_KEY")',
    );
  });
});
