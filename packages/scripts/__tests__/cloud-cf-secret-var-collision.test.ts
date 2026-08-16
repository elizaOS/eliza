/**
 * Guards the Worker secret/var namespace: Cloudflare rejects `wrangler secret
 * put NAME` with error 10053 when the served Worker version already defines
 * NAME as a plain [vars] binding. This collision class caused two live
 * incidents (CARTESIA_API_KEY at launch; the legacy Personal Shared Telegram
 * edge flag on the 2026-08-16 staging flip). Every workflow-published secret is
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
  // activate-personal-shared-telegram-edge.yml (staging-only protected cutover)
  {
    name: "PERSONAL_SHARED_TELEGRAM_EDGE_CUTOVER_ENABLED",
    envs: ["staging"],
  },
];

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
      for (const match of source.matchAll(
        /secret\s+put\s+"?\$?\{?\{?\s*([A-Z][A-Z0-9_]+)/g,
      )) {
        const token = match[1];
        // Indirect names (secret put "$SECRET_NAME") resolve through workflow
        // env vars; capture the literal env-var values on SECRET_NAME-style
        // assignments instead.
        if (
          token === "SECRET_NAME" ||
          token === "GITHUB" ||
          token === "INPUT"
        ) {
          continue;
        }
        if (!mapped.has(token)) unmapped.add(token);
      }
      for (const match of source.matchAll(
        /SECRET_NAME:\s*"?([A-Z][A-Z0-9_]+)"?/g,
      )) {
        if (!mapped.has(match[1])) unmapped.add(match[1]);
      }
    }
    expect([...unmapped].sort()).toEqual([]);
  });

  test("keeps production on the inert legacy off flag without defining the cutover binding", () => {
    // `keep_vars` may retain the legacy plaintext binding in deployed versions.
    // Runtime authorization reads only the fresh cutover name, so production
    // keeps the legacy value explicitly off and must not define the new name.
    expect(
      vars.get("production")?.has("PERSONAL_SHARED_TELEGRAM_EDGE_ENABLED") ??
        false,
    ).toBe(true);
    expect(
      vars
        .get("production")
        ?.has("PERSONAL_SHARED_TELEGRAM_EDGE_CUTOVER_ENABLED") ?? false,
    ).toBe(false);
  });
});
