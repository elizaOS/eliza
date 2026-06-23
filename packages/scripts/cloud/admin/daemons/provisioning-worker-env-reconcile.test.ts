import { describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Regression guard for #8756 (operator-step bug): the provisioning-worker
// deploy workflow must reconcile SANDBOX_REGISTRY_REDIS_URL into the systemd
// EnvironmentFile (/opt/eliza/cloud/.env.local). The daemon's consumer reads
// it straight from process.env (docker-sandbox-provider.ts) fed by that file;
// if the workflow doesn't write it, provisioned sandboxes never self-register
// and Discord/Telegram inbound routing silently breaks.

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../../../..");
const workflowPath = path.join(
  repoRoot,
  ".github/workflows/deploy-eliza-provisioning-worker.yml",
);
const workflow = readFileSync(workflowPath, "utf8");

const ENV_KEY = "SANDBOX_REGISTRY_REDIS_URL";

describe("deploy-eliza-provisioning-worker.yml SANDBOX_REGISTRY_REDIS_URL wiring", () => {
  it("sources the key from the GitHub secret into the deploy job env", () => {
    expect(workflow).toContain(
      `${ENV_KEY}: \${{ secrets.${ENV_KEY} }}`,
    );
  });

  it("forwards the key to the remote deploy script via the ssh-action envs allowlist", () => {
    // appleboy/ssh-action only exports env vars named in `envs:`. If the key
    // isn't there, $SANDBOX_REGISTRY_REDIS_URL is empty inside the remote
    // script and the reconcile loop below silently skips it.
    const envsLine = workflow
      .split("\n")
      .find((line) => line.trim().startsWith("envs:") && line.includes(ENV_KEY));
    expect(envsLine).toBeDefined();
    const forwarded = (envsLine ?? "")
      .slice(envsLine!.indexOf("envs:") + "envs:".length)
      .split(",")
      .map((name) => name.trim());
    expect(forwarded).toContain(ENV_KEY);
  });

  it("includes the key in the .env.local reconcile loop targeting /opt/eliza/cloud/.env.local", () => {
    expect(workflow).toContain('ENV_FILE=/opt/eliza/cloud/.env.local');
    // The loop body iterates "KEY=$VALUE" entries; the entry for our key must
    // be present so the sed-delete + tee-append rewrites it into the file.
    expect(workflow).toContain(`"${ENV_KEY}=$${ENV_KEY}"`);
  });
});

// Extract the exact reconcile loop body from the workflow and run it in a
// scratch dir so the test exercises the real bash, not a re-implementation.
function extractReconcileLoop(): string {
  const start = workflow.indexOf("for kv in \\");
  expect(start).toBeGreaterThan(-1);
  const tail = workflow.slice(start);
  const doneIdx = tail.indexOf("\n            done");
  expect(doneIdx).toBeGreaterThan(-1);
  // Include the "done" line itself.
  const block = tail.slice(0, doneIdx + "\n            done".length);
  // De-indent the 12-space YAML script indentation.
  return block
    .split("\n")
    .map((line) => (line.startsWith("            ") ? line.slice(12) : line))
    .join("\n");
}

function runReconcile(opts: {
  redisUrl: string | undefined;
  seedEnvFile?: string;
}): string {
  const loop = extractReconcileLoop();
  const dir = mkdtempSync(path.join(tmpdir(), "reconcile-"));
  const envFile = path.join(dir, "env.local");
  if (opts.seedEnvFile !== undefined) {
    writeFileSync(envFile, opts.seedEnvFile);
  } else {
    writeFileSync(envFile, "");
  }
  // The workflow uses `sudo`; replace it with a no-op so the loop runs
  // unprivileged in the scratch dir, and bind ENV_FILE to our temp path.
  const script = [
    "set -euo pipefail",
    "sudo() { \"$@\"; }",
    `ENV_FILE='${envFile}'`,
    // The ssh-action `envs:` allowlist always exports these (possibly empty);
    // under `set -u` they must be defined or the loop aborts. Empty == skipped,
    // isolating SANDBOX_REGISTRY_REDIS_URL behavior.
    "HEADSCALE_API_URL=''",
    "HEADSCALE_PUBLIC_URL=''",
    "HEADSCALE_API_KEY=''",
    loop,
  ].join("\n");
  try {
    execFileSync("bash", ["-c", script], {
      cwd: dir,
      env: {
        PATH: process.env.PATH ?? "",
        // The `envs:` allowlist always exports the name; an unset GH secret
        // surfaces as the empty string in the remote shell, not as undefined.
        [ENV_KEY]: opts.redisUrl ?? "",
      },
    });
    return readFileSync(envFile, "utf8");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("provisioning-worker .env.local reconcile loop (executed)", () => {
  it("writes SANDBOX_REGISTRY_REDIS_URL into .env.local when the secret is set", () => {
    const url = "redis://sandbox-registry.example.internal:6379";
    const out = runReconcile({ redisUrl: url });
    expect(out).toContain(`${ENV_KEY}=${url}\n`);
  });

  it("replaces a stale hand-set value rather than appending a duplicate", () => {
    const out = runReconcile({
      redisUrl: "redis://new.example:6379",
      seedEnvFile: `${ENV_KEY}=redis://stale.example:6379\nOTHER=keep\n`,
    });
    const matches = out
      .split("\n")
      .filter((line) => line.startsWith(`${ENV_KEY}=`));
    expect(matches).toEqual([`${ENV_KEY}=redis://new.example:6379`]);
    // Unrelated keys are preserved.
    expect(out).toContain("OTHER=keep");
  });

  it("skips the key (preserving any hand-set value) when the secret is unset", () => {
    const out = runReconcile({
      redisUrl: undefined,
      seedEnvFile: `${ENV_KEY}=redis://hand-set.example:6379\n`,
    });
    // An unset GH secret must never blank a working box.
    expect(out).toContain(`${ENV_KEY}=redis://hand-set.example:6379`);
  });

  it("skips the key when the secret is the empty string", () => {
    const out = runReconcile({ redisUrl: "" });
    expect(out).not.toContain(ENV_KEY);
  });
});
