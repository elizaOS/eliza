#!/usr/bin/env node
/**
 * Read-only evidence collector for the launch-hardening operator lane.
 *
 * Gathers the public GitHub state for #12081, superseding #8756, so reviewers
 * can decide whether closeout is ready without printing secret values or
 * mutating live infrastructure.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const arg = (name, fallback = null) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
};

const repo = arg("--repo", "elizaOS/eliza");
const branch = arg("--branch", "develop");
const environment = arg("--environment", "production");
const image = arg("--image", "ghcr.io/elizaos/eliza:develop");
const cloudSecretName = arg("--cloud-secret-name", "ELIZACLOUD_API_KEY");
const cloudTokenEnvName = "ELIZA_CLOUD_AUTH_TOKEN";
const outDir = arg(
  "--out-dir",
  ".github/issue-evidence/8756-launch-hardening-status",
);
const cloudReport = arg("--cloud-report");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
  };
}

function runJson(command, args) {
  const result = run(command, args);
  if (!result.ok) return { ok: false, error: result.stderr || result.stdout };
  try {
    return { ok: true, value: JSON.parse(result.stdout) };
  } catch (error) {
    return {
      ok: false,
      error: `failed to parse JSON from ${command}: ${
        error instanceof Error ? error.message : String(error)
      }`,
      raw: result.stdout,
    };
  }
}

function latestRun(workflow) {
  const result = runJson("gh", [
    "run",
    "list",
    "-R",
    repo,
    "--workflow",
    workflow,
    "--branch",
    branch,
    "--limit",
    "1",
    "--json",
    "databaseId,status,conclusion,createdAt,updatedAt,headSha,displayTitle,event,url",
  ]);
  if (!result.ok) return { ok: false, error: result.error };
  return { ok: true, run: result.value?.[0] ?? null };
}

function listEnvironmentSecrets() {
  const result = runJson("gh", [
    "secret",
    "list",
    "-R",
    repo,
    "--env",
    environment,
    "--json",
    "name,updatedAt,visibility",
  ]);
  if (!result.ok) return { ok: false, error: result.error };
  const expected = [
    "SANDBOX_REGISTRY_REDIS_URL",
    "ELIZA_PROVISIONING_HOST",
    "ELIZA_PROVISIONING_SSH_KEY",
  ];
  const byName = new Map(
    result.value.map((secret) => [
      secret.name,
      {
        name: secret.name,
        present: true,
        updatedAt: secret.updatedAt ?? null,
        visibility: secret.visibility ?? null,
      },
    ]),
  );
  return {
    ok: true,
    expected: expected.map(
      (name) =>
        byName.get(name) ?? {
          name,
          present: false,
          updatedAt: null,
          visibility: null,
        },
    ),
    count: result.value.length,
  };
}

function listRepoSecret(name) {
  const result = runJson("gh", [
    "secret",
    "list",
    "-R",
    repo,
    "--json",
    "name,updatedAt,visibility",
  ]);
  if (!result.ok) {
    return {
      ok: false,
      name,
      present: Boolean(process.env[cloudTokenEnvName]),
      updatedAt: null,
      visibility: null,
      error: result.error,
      source: "env-fallback",
    };
  }
  const found = result.value.find((secret) => secret.name === name);
  return {
    ok: true,
    name,
    present: Boolean(found),
    updatedAt: found?.updatedAt ?? null,
    visibility: found?.visibility ?? null,
    source: "github-repo-secret-list",
  };
}

function developHead() {
  const result = runJson("gh", [
    "api",
    `repos/${repo}/git/ref/heads/${branch}`,
    "--jq",
    ".object.sha",
  ]);
  if (!result.ok) {
    const fallback = run("gh", [
      "api",
      `repos/${repo}/git/ref/heads/${branch}`,
      "--jq",
      ".object.sha",
    ]);
    return {
      ok: fallback.ok,
      sha: fallback.ok ? fallback.stdout : null,
      error: fallback.ok ? null : fallback.stderr || fallback.stdout,
    };
  }
  return { ok: true, sha: result.value };
}

function inspectImageDigest() {
  const result = run("docker", ["buildx", "imagetools", "inspect", image]);
  if (!result.ok)
    return { ok: false, image, error: result.stderr || result.stdout };
  const digest =
    result.stdout.match(/Digest:\s+(sha256:[a-f0-9]{64})/)?.[1] ?? null;
  return {
    ok: true,
    image,
    digest,
    outputExcerpt: result.stdout.split("\n").slice(0, 12).join("\n"),
  };
}

function readOptionalCloudReport() {
  if (!cloudReport) return null;
  const result = run("node", [
    "packages/app/scripts/cloud-provisioning-e2e.mjs",
    "--fresh-agent",
    "--report",
    cloudReport,
  ]);
  return {
    attempted: true,
    ok: result.ok,
    reportPath: cloudReport,
    stdout: result.stdout.slice(0, 2000),
    stderr: result.stderr.slice(0, 2000),
  };
}

function runSelfChecks() {
  return {
    provisioningWorkerEnvReconcile: run("bun", [
      "test",
      "packages/scripts/cloud/admin/daemons/provisioning-worker-env-reconcile.test.ts",
    ]),
  };
}

function verdict(report) {
  const requiredSecretsPresent = report.environmentSecrets.expected.every(
    (secret) => secret.present,
  );
  const imageReady =
    report.workflows.buildAgentImage.run?.status === "completed" &&
    report.workflows.buildAgentImage.run?.conclusion === "success";
  const deployReady =
    report.workflows.deployProvisioningWorker.run?.status === "completed" &&
    report.workflows.deployProvisioningWorker.run?.conclusion === "success";
  const cloudVerified = report.cloudProvisioning?.ok === true;
  return {
    requiredSecretsPresent,
    imageReady,
    deployReady,
    cloudVerified,
    closeable:
      requiredSecretsPresent && imageReady && deployReady && cloudVerified,
  };
}

function table(rows) {
  return rows
    .map(
      (row) =>
        `| ${row.map((cell) => String(cell).replaceAll("\n", "<br>")).join(" | ")} |`,
    )
    .join("\n");
}

function renderMarkdown(report) {
  const v = report.verdict;
  return `# #12081 / #8756 Launch-Hardening Status

Generated: ${report.generatedAt}

This is a read-only collector. It does not deploy, approve environments, SSH to
hosts, or print secret values.

## Verdict

${table([
  ["Check", "Status"],
  [
    "Required production environment secrets exist",
    v.requiredSecretsPresent ? "yes" : "no",
  ],
  [
    "Latest build-agent-image run for develop is green",
    v.imageReady ? "yes" : "no",
  ],
  [
    "Latest provisioning-worker deploy for develop is green",
    v.deployReady ? "yes" : "no",
  ],
  [
    "Fresh-agent cloud provisioning probe passed",
    v.cloudVerified ? "yes" : "no / not run",
  ],
  ["Issue closeable from this evidence alone", v.closeable ? "yes" : "no"],
])}

## Develop Head

- Branch: \`${report.branch}\`
- SHA: \`${report.developHead.sha ?? "unknown"}\`

## Environment Secrets (${report.environment})

${table([
  ["Secret", "Present", "Updated At"],
  ...report.environmentSecrets.expected.map((secret) => [
    secret.name,
    secret.present ? "yes" : "no",
    secret.updatedAt ?? "n/a",
  ]),
])}

## Cloud Auth Secret

${table([
  ["Secret", "Present", "Updated At", "Source"],
  [
    report.cloudAuthSecret.name,
    report.cloudAuthSecret.present ? "yes" : "no",
    report.cloudAuthSecret.updatedAt ?? "n/a",
    report.cloudAuthSecret.source,
  ],
])}

## Workflows

${table([
  ["Workflow", "Run", "Status", "Conclusion", "Head SHA", "Updated"],
  [
    "Build Agent Image",
    report.workflows.buildAgentImage.run?.url ?? "missing",
    report.workflows.buildAgentImage.run?.status ?? "missing",
    report.workflows.buildAgentImage.run?.conclusion ?? "",
    report.workflows.buildAgentImage.run?.headSha ?? "",
    report.workflows.buildAgentImage.run?.updatedAt ?? "",
  ],
  [
    "Deploy Eliza Provisioning Worker",
    report.workflows.deployProvisioningWorker.run?.url ?? "missing",
    report.workflows.deployProvisioningWorker.run?.status ?? "missing",
    report.workflows.deployProvisioningWorker.run?.conclusion ?? "",
    report.workflows.deployProvisioningWorker.run?.headSha ?? "",
    report.workflows.deployProvisioningWorker.run?.updatedAt ?? "",
  ],
])}

## Image

- Image: \`${report.image.image}\`
- Digest: \`${report.image.digest ?? "unavailable"}\`
- Inspect succeeded: ${report.image.ok ? "yes" : "no"}

## Local Regression Check

- \`provisioning-worker-env-reconcile.test.ts\`: ${
    report.selfChecks.provisioningWorkerEnvReconcile.ok ? "passed" : "failed"
  }

## Fresh-Agent Probe

${
  report.cloudProvisioning
    ? `- Attempted: yes
- Passed: ${report.cloudProvisioning.ok ? "yes" : "no"}
- Report path: \`${report.cloudProvisioning.reportPath}\``
    : "- Attempted: no. Pass `--cloud-report <path>` with `ELIZA_CLOUD_AUTH_TOKEN` available to run the real fresh-agent probe."
}

## Remaining

This evidence can close the #12081 operator lane only when all verdict rows are
green. If the workflow rows are still pending, cancelled, or missing, the live
operator lane has not been proven complete. If the fresh-agent probe is not run,
persistence, lean-plugin loading, and runtime reachability remain unverified.
`;
}

mkdirSync(outDir, { recursive: true });
const report = {
  generatedAt: new Date().toISOString(),
  repo,
  branch,
  environment,
  developHead: developHead(),
  environmentSecrets: listEnvironmentSecrets(),
  cloudAuthSecret: listRepoSecret(cloudSecretName),
  workflows: {
    buildAgentImage: latestRun("build-agent-image.yml"),
    deployProvisioningWorker: latestRun("deploy-eliza-provisioning-worker.yml"),
  },
  image: inspectImageDigest(),
  selfChecks: runSelfChecks(),
  cloudProvisioning: readOptionalCloudReport(),
};
report.verdict = verdict(report);

writeFileSync(
  path.join(outDir, "status.json"),
  `${JSON.stringify(report, null, 2)}\n`,
);
writeFileSync(path.join(outDir, "README.md"), renderMarkdown(report));
console.log(JSON.stringify(report.verdict, null, 2));
