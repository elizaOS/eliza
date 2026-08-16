/**
 * Guards the migration-safe Personal Shared Telegram edge cutover: exact
 * Worker and gateway source proof, protected activation, and rollback.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const repoRoot = new URL("../../../", import.meta.url);
const source = readFileSync(
  new URL(
    ".github/workflows/activate-personal-shared-telegram-edge.yml",
    repoRoot,
  ),
  "utf8",
);

interface WorkflowStep {
  name?: string;
  if?: string;
  env?: Record<string, string>;
  run?: string;
}

interface Workflow {
  permissions?: Record<string, string>;
  concurrency?: Record<string, string | boolean>;
  jobs?: Record<
    string,
    {
      environment?: string;
      env?: Record<string, string>;
      steps?: WorkflowStep[];
    }
  >;
}

const workflow = Bun.YAML.parse(source) as Workflow;
const job = workflow.jobs?.cutover;
const steps = job?.steps ?? [];

function step(name: string): WorkflowStep {
  const found = steps.find((candidate) => candidate.name === name);
  if (!found?.run) throw new Error(`Missing executable workflow step: ${name}`);
  return found;
}

function index(name: string): number {
  return steps.findIndex((candidate) => candidate.name === name);
}

describe("Personal Shared Telegram edge deploy", () => {
  test("is staging-only, serialized, and least-privileged", () => {
    expect(job?.environment).toBe("staging");
    expect(workflow.permissions).toEqual({ actions: "read", contents: "read" });
    expect(workflow.concurrency?.group).toBe(
      "activate-personal-shared-telegram-edge-staging",
    );
    expect(workflow.concurrency?.["cancel-in-progress"]).toBe(false);
    expect(job?.env?.HEALTH_URL).toBe(
      "https://api-staging.eliza.app/api/health",
    );
    expect(job?.env?.GATEWAY_URL).toBe(
      "https://gateway-webhook-stg-staging.up.railway.app",
    );
    expect(source).not.toContain("api.eliza.app/api/health");
    expect(source).not.toContain("--env production");
  });

  test("proves exact served Worker and gateway sources before enable", () => {
    const ordered = [
      "Validate exact served Worker source",
      "Verify exact-source gateway before enable",
      "Apply and verify served edge state",
      "Write cutover summary",
    ].map(index);
    expect(ordered.every((value) => value >= 0)).toBe(true);
    expect(ordered).toEqual([...ordered].sort((a, b) => a - b));

    const worker = step("Validate exact served Worker source");
    expect(worker.run).toContain('"refs/heads/develop"');
    expect(worker.run).toContain("git merge-base --is-ancestor");
    expect(worker.run).toContain(".commit == $sha");
    expect(worker.run).toContain("personalSharedTelegramEdge.enabled");

    const gateway = step("Verify exact-source gateway before enable");
    expect(gateway.if).toContain("inputs.enabled == true");
    expect(gateway.run).toContain(
      "actions/workflows/deploy-gateway-webhook.yml/runs",
    );
    expect(gateway.run).toContain(".[0].head_sha == $sha");
    expect(gateway.run).toContain('.[0].conclusion == "success"');
    expect(gateway.run).toContain("$GATEWAY_URL/health");
    expect(gateway.run).toContain("ready/forwarder-auth/eliza-app");
  });

  test("applies the gate last and rolls every unproven exit back off", () => {
    const apply = step("Apply and verify served edge state");
    expect(apply.run).toContain("wrangler@4.100.0 secret put");
    expect(apply.run).toContain(
      "PERSONAL_SHARED_TELEGRAM_EDGE_ENABLED --env staging",
    );
    expect(apply.run).toContain("ensure-worker-secret-absent.mjs");
    expect(apply.run).toContain("trap rollback_on_unproven_exit EXIT");
    expect(apply.run).toContain(".commit == $sha");
    expect(apply.run).toContain(
      ".personalSharedTelegramEdge.enabled == $enabled",
    );
    expect(apply.run).toContain("if disable_edge; then");
    expect(apply.run).not.toContain('grep -qi "not found"');
  });

  test("keeps every tracked Worker environment fail-closed", () => {
    const config = Bun.TOML.parse(
      readFileSync(
        new URL("packages/cloud/api/wrangler.toml", repoRoot),
        "utf8",
      ),
    ) as {
      vars?: Record<string, string>;
      env?: Record<string, { vars?: Record<string, string> }>;
    };
    expect(config.vars?.PERSONAL_SHARED_TELEGRAM_EDGE_ENABLED).toBe("false");
    expect(
      config.env?.staging?.vars?.PERSONAL_SHARED_TELEGRAM_EDGE_ENABLED,
    ).toBe("false");
    expect(
      config.env?.production?.vars?.PERSONAL_SHARED_TELEGRAM_EDGE_ENABLED,
    ).toBe("false");
  });
});
