// Exercises cloud admin daemons provisioning worker env reconcile.test automation behavior with deterministic script fixtures.
import { describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Regression guard for #8756 (operator-step bug): the provisioning-worker
// deploy workflow must reconcile control-plane secrets into the systemd
// EnvironmentFile (/opt/eliza/cloud/.env.local). The daemon's consumers read
// them straight from process.env fed by that file; if the workflow doesn't
// write them, provisioned sandboxes lose routing secrets or cannot decrypt
// Worker-written encrypted environment variables.

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../../../..");
const workflowPath = path.join(
  repoRoot,
  ".github/workflows/deploy-eliza-provisioning-worker.yml",
);
const workflow = readFileSync(workflowPath, "utf8");

const ENV_KEY = "SANDBOX_REGISTRY_REDIS_URL";
const FIELD_ENCRYPTION_KEY = "SECRETS_MASTER_KEY";
const BRIDGE_FALLBACK_KEY = "AGENT_ROUTER_ALLOW_BRIDGE_HOST_FALLBACK";
const AGENT_BASE_DOMAIN_KEY = "ELIZA_CLOUD_AGENT_BASE_DOMAIN";
const CONTAINERS_SSH_KEY = "CONTAINERS_SSH_KEY";

// The reconcile loop runs the workflow's VERBATIM bash, which uses GNU
// `sed -i "/^KEY=/d"` (no backup-suffix argument). BSD/macOS `sed -i` parses
// that as a suffix and fails, so the executed cases only run where a
// GNU-compatible sed exists. CI (Linux) has GNU sed natively; a macOS dev with
// `brew install gnu-sed` gets coverage via the `gsed` shim injected in
// runReconcile; otherwise the executed cases skip (the static wiring assertions
// above still run on every platform).
function resolveGnuSed(): string | null {
  for (const candidate of ["sed", "gsed"]) {
    try {
      const out = execFileSync(candidate, ["--version"], { encoding: "utf8" });
      if (out.includes("GNU sed")) return candidate;
    } catch {
      // candidate missing or not GNU — keep looking.
    }
  }
  return null;
}
const GNU_SED = resolveGnuSed();

describe("deploy-eliza-provisioning-worker.yml SANDBOX_REGISTRY_REDIS_URL wiring", () => {
  it("sources the key from the GitHub secret into the deploy job env", () => {
    expect(workflow).toContain(`${ENV_KEY}: \${{ secrets.${ENV_KEY} }}`);
  });

  it("forwards the key to the remote deploy script via the ssh-action envs allowlist", () => {
    // appleboy/ssh-action only exports env vars named in `envs:`. If the key
    // isn't there, $SANDBOX_REGISTRY_REDIS_URL is empty inside the remote
    // script and the reconcile loop below silently skips it.
    const envsLine = workflow
      .split("\n")
      .find(
        (line) => line.trim().startsWith("envs:") && line.includes(ENV_KEY),
      );
    expect(envsLine).toBeDefined();
    const line = envsLine ?? "";
    const forwarded = line
      .slice(line.indexOf("envs:") + "envs:".length)
      .split(",")
      .map((name) => name.trim());
    expect(forwarded).toContain(ENV_KEY);
  });

  it("includes the key in the .env.local reconcile loop targeting /opt/eliza/cloud/.env.local", () => {
    expect(workflow).toContain("ENV_FILE=/opt/eliza/cloud/.env.local");
    // The loop body iterates "KEY=$VALUE" entries; the entry for our key must
    // be present so the sed-delete + tee-append rewrites it into the file.
    expect(workflow).toContain(`"${ENV_KEY}=$${ENV_KEY}"`);
  });

  it("keeps the field-encryption root key in the same source/forward/reconcile path", () => {
    expect(workflow).toContain(
      `${FIELD_ENCRYPTION_KEY}: \${{ secrets.${FIELD_ENCRYPTION_KEY} }}`,
    );
    const envsLine = workflow
      .split("\n")
      .find(
        (line) =>
          line.trim().startsWith("envs:") &&
          line.includes(FIELD_ENCRYPTION_KEY),
      );
    expect(envsLine).toBeDefined();
    expect(workflow).toContain(
      `"${FIELD_ENCRYPTION_KEY}=$${FIELD_ENCRYPTION_KEY}"`,
    );
  });

  it("reconciles the protected agent-node SSH key into the daemon environment", () => {
    expect(workflow).toContain(
      `${CONTAINERS_SSH_KEY}: \${{ secrets.${CONTAINERS_SSH_KEY} }}`,
    );
    const envsLine = workflow
      .split("\n")
      .find(
        (line) =>
          line.trim().startsWith("envs:") && line.includes(CONTAINERS_SSH_KEY),
      );
    expect(envsLine).toBeDefined();
    expect(workflow).toContain(
      `"${CONTAINERS_SSH_KEY}=$${CONTAINERS_SSH_KEY}"`,
    );
  });

  it("scrubs the deprecated bridge-host fallback flag during env reconciliation", () => {
    expect(workflow).toContain(
      `sed -i "/^${BRIDGE_FALLBACK_KEY}=/d" "$ENV_FILE"`,
    );
    const lanePinIdx = workflow.indexOf('sed -i "/^PROVISIONING_JOB_LANES=/d"');
    const scrubIdx = workflow.indexOf(`${BRIDGE_FALLBACK_KEY}=/d`);
    const secretLoopIdx = workflow.indexOf("for kv in \\");
    expect(lanePinIdx).toBeGreaterThan(-1);
    expect(scrubIdx).toBeGreaterThan(-1);
    expect(secretLoopIdx).toBeGreaterThan(-1);
    expect(lanePinIdx).toBeLessThan(scrubIdx);
    expect(scrubIdx).toBeLessThan(secretLoopIdx);
  });

  it("pins the agent router to the protected deployment environment", () => {
    expect(workflow).toContain(
      `${AGENT_BASE_DOMAIN_KEY}: \${{ needs.determine-env.outputs.environment == 'production' && 'elizacloud.ai' || 'staging.elizacloud.ai' }}`,
    );
    const deployEnvs = workflow
      .split("\n")
      .find(
        (line) =>
          line.trim().startsWith("envs:") && line.includes("DEPLOY_SHA"),
      );
    expect(deployEnvs).toContain(AGENT_BASE_DOMAIN_KEY);
    expect(workflow).toContain(
      `"${AGENT_BASE_DOMAIN_KEY}=$${AGENT_BASE_DOMAIN_KEY}"`,
    );
    expect(workflow).toContain(
      "Agent router base-domain drift: expected $ELIZA_CLOUD_AGENT_BASE_DOMAIN",
    );
  });
});

// Extract the exact reconcile loop body from the workflow and run it in a
// scratch dir so the test exercises the real bash, not a re-implementation.
function extractReconcileLoop(): string {
  const start = workflow.indexOf('sudo sed -i "/^PROVISIONING_JOB_LANES=/d"');
  expect(start).toBeGreaterThan(-1);
  const tail = workflow.slice(start);
  const doneIdx = tail.indexOf("\n            done");
  expect(doneIdx).toBeGreaterThan(-1);
  // Include the "done" line itself.
  const block = tail.slice(0, doneIdx + "\n            done".length);
  // De-indent the 12-space YAML script indentation.
  const loop = block
    .split("\n")
    .map((line) => (line.startsWith("            ") ? line.slice(12) : line))
    .join("\n");
  // Fail loudly if anchor drift (a renamed loop var, reindented script block, a
  // reformatted `done`, or a swapped ssh-action) extracted a trivial/empty
  // block — otherwise the executed cases would silently exercise nothing.
  expect(loop).toContain("sed -i");
  expect(loop).toContain("tee -a");
  expect(loop).toContain(ENV_KEY);
  expect(loop).toContain(BRIDGE_FALLBACK_KEY);
  return loop;
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
  // unprivileged in the scratch dir, and bind ENV_FILE to the test path.
  const script = [
    "set -euo pipefail",
    'sudo() { "$@"; }',
    // On a macOS dev box with `brew install gnu-sed`, route the loop's `sed`
    // through `gsed` so the verbatim GNU `sed -i` invocation behaves. On Linux
    // (GNU sed is the default) and when skipped this is a no-op.
    GNU_SED === "gsed" ? 'sed() { gsed "$@"; }' : "",
    `ENV_FILE='${envFile}'`,
    // The ssh-action `envs:` allowlist always exports every key the loop reads
    // (possibly empty); under `set -u` each must be defined or the loop aborts.
    // Derive them from the loop's own `"KEY=$KEY"` entries and default every key
    // EXCEPT the one under test to empty (empty == skipped, isolating
    // SANDBOX_REGISTRY_REDIS_URL behavior) — so a workflow that forwards another
    // secret (e.g. DATABASE_URL) can't silently abort this test on `set -u`.
    ...Array.from(
      new Set(
        Array.from(
          loop.matchAll(/"([A-Z0-9_]+)=\$[A-Z0-9_]+"/g),
          (match) => match[1],
        ),
      ),
    )
      .filter((name) => name !== ENV_KEY)
      .map((name) => `${name}=''`),
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

// Skip the executed cases when no GNU-compatible sed is reachable (BSD/macOS
// without gsed); CI runs on Linux with GNU sed and keeps full coverage.
const executedDescribe = GNU_SED ? describe : describe.skip;
executedDescribe(
  "provisioning-worker .env.local reconcile loop (executed)",
  () => {
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

    it("removes the deprecated bridge-host fallback flag on every deploy", () => {
      const out = runReconcile({
        redisUrl: undefined,
        seedEnvFile: `${BRIDGE_FALLBACK_KEY}=1\nOTHER=keep\n`,
      });
      expect(out).not.toContain(BRIDGE_FALLBACK_KEY);
      expect(out).toContain("PROVISIONING_JOB_LANES=agent\n");
      expect(out).toContain("OTHER=keep\n");
    });
  },
);
