#!/usr/bin/env node
/**
 * Bootstrap the persistent Hetzner host used by
 * .github/workflows/deploy-eliza-provisioning-worker.yml.
 *
 * This is a one-shot operator script. It creates or reuses a labeled Hetzner
 * Cloud VM, installs the deploy user and system dependencies, copies the cloud
 * runtime env file to /opt/eliza/cloud/.env.local, starts the systemd worker,
 * and writes the GitHub environment secrets consumed by the deploy workflow.
 *
 * Usage:
 *   HCLOUD_TOKEN=... bun run provisioning-worker:bootstrap --environment staging
 *   HETZNER_CLOUD_API_KEY=... node packages/scripts/bootstrap-provisioning-worker-host.mjs --environment production
 */

import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import dotenv from "dotenv";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const cloudRoot = resolve(scriptDir, "..", "..");
const repoRoot = resolve(cloudRoot, "..");

const { values } = parseArgs({
  options: {
    environment: { type: "string", short: "e", default: "staging" },
    branch: { type: "string" },
    "github-repo": { type: "string", default: "elizaOS/eliza" },
    "repo-url": { type: "string", default: "https://github.com/elizaOS/eliza.git" },
    "env-file": { type: "string", default: join(cloudRoot, ".env.local") },
    "server-name": { type: "string" },
    "server-type": { type: "string", default: "cpx21" },
    location: { type: "string" },
    image: { type: "string", default: "ubuntu-24.04" },
    "skip-github-secrets": { type: "boolean", default: false },
    "skip-remote-deploy": { type: "boolean", default: false },
    "allow-incomplete-env": { type: "boolean", default: false },
    "replace-server": { type: "boolean", default: false },
    "rotate-ssh-key": { type: "boolean", default: false },
    "dry-run": { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
});

if (values.help) {
  printHelp();
  process.exit(0);
}

const environment = String(values.environment);
if (!["staging", "production"].includes(environment)) {
  fail(`--environment must be "staging" or "production" (received ${environment})`);
}

const branch = String(values.branch ?? (environment === "production" ? "main" : "develop"));
const envFile = resolve(String(values["env-file"]));
const hcloudToken = readFirstEnv("HCLOUD_TOKEN", "HETZNER_CLOUD_TOKEN", "HETZNER_CLOUD_API_KEY");
const serverName = String(values["server-name"] ?? `eliza-provisioning-worker-${environment}`);
const keyDir = join(repoRoot, ".eliza", "provisioning-worker", environment);
const keyPath = join(keyDir, "deploy_ed25519");
const publicKeyPath = `${keyPath}.pub`;
const hadExistingSshKey = existsSync(keyPath) && existsSync(publicKeyPath);
const label = {
  app: "eliza-provisioning-worker",
  environment,
};

if (!hcloudToken) {
  fail("Set HCLOUD_TOKEN or HETZNER_CLOUD_API_KEY before running this script.");
}
if (!existsSync(envFile)) {
  fail(`Env file not found: ${envFile}`);
}

const sourceEnv = dotenv.parse(readFileSync(envFile, "utf8"));
const location = String(values.location ?? sourceEnv.CONTAINERS_HCLOUD_LOCATION ?? "fsn1");
validateRuntimeEnv(sourceEnv);

log(`environment: ${environment}`);
log(`branch:      ${branch}`);
log(`server:      ${serverName}`);
log(`location:    ${location}`);
log(`env file:    ${envFile}`);
log(`github repo: ${values["github-repo"]}`);
log(`dry run:     ${values["dry-run"] ? "yes" : "no"}`);
log("");

if (values["dry-run"]) {
  log("Dry run complete. No Hetzner, SSH, or GitHub changes were made.");
  process.exit(0);
}

ensureSshKey();

const server = await resolveServer();
const host = getServerHost(server);
if (!host) {
  fail(`Hetzner server ${server.name} has no public IPv4 address.`);
}

log(`host:        ${host}`);

if (!values["skip-remote-deploy"]) {
  await waitForSsh(host);
  await deployWorker(host);
  await writeRemoteEnv(host);
  await restartWorker(host);
  await assertWorkerHealthy(host);
}

if (!values["skip-github-secrets"]) {
  await setGitHubSecret("ELIZA_PROVISIONING_HOST", host);
  await setGitHubSecret("ELIZA_PROVISIONING_SSH_KEY", readFileSync(keyPath, "utf8"));
}

log("");
log("done.");
log(
  `GitHub environment '${environment}' now has ELIZA_PROVISIONING_HOST and ELIZA_PROVISIONING_SSH_KEY.`,
);
log("The deploy workflow can be rerun for this environment.");

function printHelp() {
  console.log(`
Bootstrap the Hetzner host used by the Eliza provisioning-worker deploy workflow.

Required:
  HCLOUD_TOKEN or HETZNER_CLOUD_API_KEY in the local environment.
  A cloud runtime env file, defaulting to cloud/.env.local.

Examples:
  HCLOUD_TOKEN=... bun run --cwd cloud provisioning-worker:bootstrap --environment staging
  HCLOUD_TOKEN=... bun run --cwd cloud provisioning-worker:bootstrap --environment production --env-file cloud/.env.production

Options:
  --environment staging|production   GitHub environment and deploy branch default.
  --branch <name>                    Override branch (default: develop/staging, main/production).
  --env-file <path>                  Runtime env copied to /opt/eliza/cloud/.env.local.
  --server-type <type>               Hetzner type (default: cpx21).
  --location <code>                  Hetzner location (default: CONTAINERS_HCLOUD_LOCATION or fsn1).
  --replace-server                   Delete and recreate an existing labeled server.
  --rotate-ssh-key                   Generate a new deploy key before creating a server.
  --skip-github-secrets              Do not write GitHub Actions secrets.
  --skip-remote-deploy               Only provision the server and secrets.
  --dry-run                          Print the resolved plan only.
`);
}

function readFirstEnv(...keys) {
  for (const key of keys) {
    const value = process.env[key]?.trim();
    if (value) return value;
  }
  return undefined;
}

function validateRuntimeEnv(env) {
  const required = ["DATABASE_URL", "NEON_API_KEY", "CONTAINERS_SSH_KEY"];
  const missing = required.filter((key) => !env[key]?.trim());
  if (missing.length === 0 || values["allow-incomplete-env"]) return;

  fail(
    [
      `Runtime env file is missing required key(s): ${missing.join(", ")}`,
      "The worker may start without these, but agent provisioning will fail.",
      "Pass --allow-incomplete-env only if you are intentionally bootstrapping in stages.",
    ].join("\n"),
  );
}

function ensureSshKey() {
  mkdirSync(keyDir, { recursive: true });
  if (values["rotate-ssh-key"]) {
    rmSync(keyPath, { force: true });
    rmSync(publicKeyPath, { force: true });
  }
  if (existsSync(keyPath) && existsSync(publicKeyPath)) return;

  log(`generating deploy ssh key in ${keyDir}`);
  const result = spawnSync(
    "ssh-keygen",
    ["-t", "ed25519", "-C", `eliza-provisioning-worker-${environment}`, "-f", keyPath, "-N", ""],
    { stdio: "inherit" },
  );
  if (result.status !== 0) fail("ssh-keygen failed");
  chmodSync(keyPath, 0o600);
}

async function resolveServer() {
  const existing = await listServers();
  if (existing.length > 1) {
    fail(
      `Found ${existing.length} Hetzner servers with labels ${labelSelector()}; refusing to guess.`,
    );
  }

  if (existing.length === 1 && values["replace-server"]) {
    log(`deleting existing server ${existing[0].name} (${existing[0].id})`);
    await hcloud("DELETE", `/servers/${existing[0].id}`);
    await sleep(10_000);
  } else if (existing.length === 1) {
    if (values["rotate-ssh-key"] || !hadExistingSshKey) {
      fail(
        [
          `Found existing server ${existing[0].name} (${existing[0].id}), but the matching local deploy key is unavailable or was rotated.`,
          `Expected key path: ${keyPath}`,
          "Use the original key, or rerun with --replace-server --rotate-ssh-key to recreate the host.",
        ].join("\n"),
      );
    }
    log(`reusing server ${existing[0].name} (${existing[0].id})`);
    return existing[0];
  }

  log(`creating Hetzner server ${serverName}`);
  const publicKey = readFileSync(publicKeyPath, "utf8").trim();
  const response = await hcloud("POST", "/servers", {
    name: serverName,
    server_type: values["server-type"],
    location,
    image: values.image,
    user_data: buildUserData(publicKey),
    start_after_create: true,
    labels: label,
  });

  const serverId = response.server.id;
  for (let attempt = 1; attempt <= 60; attempt++) {
    const current = await hcloud("GET", `/servers/${serverId}`);
    if (current.server.status === "running") return current.server;
    log(`waiting for server ${serverName} (${current.server.status}) ${attempt}/60`);
    await sleep(5_000);
  }
  fail(`Server ${serverName} did not become running within 5 minutes.`);
}

async function listServers() {
  const data = await hcloud(
    "GET",
    `/servers?label_selector=${encodeURIComponent(labelSelector())}`,
  );
  return data.servers ?? [];
}

function labelSelector() {
  return Object.entries(label)
    .map(([key, value]) => `${key}=${value}`)
    .join(",");
}

function getServerHost(server) {
  return server.public_net?.ipv4?.ip;
}

function buildUserData(publicKey) {
  return `#!/bin/bash
set -euxo pipefail
export DEBIAN_FRONTEND=noninteractive

apt-get update
apt-get install -y ca-certificates curl git openssh-client sudo nodejs npm

if ! id deploy >/dev/null 2>&1; then
  useradd -m -s /bin/bash deploy
fi
usermod -aG sudo deploy
echo 'deploy ALL=(ALL) NOPASSWD:ALL' >/etc/sudoers.d/90-eliza-deploy
chmod 0440 /etc/sudoers.d/90-eliza-deploy

install -d -m 0700 -o deploy -g deploy /home/deploy/.ssh
cat >/home/deploy/.ssh/authorized_keys <<'KEYS'
${publicKey}
KEYS
chown deploy:deploy /home/deploy/.ssh/authorized_keys
chmod 0600 /home/deploy/.ssh/authorized_keys

install -d -m 0755 -o deploy -g deploy /opt/eliza
`;
}

async function writeRemoteEnv(host) {
  const tmp = mkdtempSync(join(tmpdir(), "eliza-provisioning-env-"));
  const localEnvPath = join(tmp, ".env.local");
  const remoteTmpPath = `/tmp/eliza-provisioning-worker-${Date.now()}.env`;
  const raw = readFileSync(envFile, "utf8");
  writeFileSync(localEnvPath, buildRemoteEnv(raw, sourceEnv), { mode: 0o600 });

  try {
    await run("scp", [...sshCommonArgs(), localEnvPath, `deploy@${host}:${remoteTmpPath}`]);
    await ssh(
      host,
      [
        "set -euo pipefail",
        "install -d -m 0755 /opt/eliza/cloud",
        `install -m 0600 ${shellQuote(remoteTmpPath)} /opt/eliza/cloud/.env.local`,
        `rm -f ${shellQuote(remoteTmpPath)}`,
      ].join("\n"),
    );
  } finally {
    rmSync(tmp, { force: true, recursive: true });
  }

  return "/opt/eliza/cloud/.env.local";
}

function buildRemoteEnv(raw, parsed) {
  const overlays = {
    NODE_ENV: "production",
    ENVIRONMENT: environment,
    NEXT_PUBLIC_API_URL:
      environment === "production"
        ? "https://api.elizacloud.ai"
        : "https://api-staging.elizacloud.ai",
    NEXT_PUBLIC_APP_URL:
      environment === "production" ? "https://elizacloud.ai" : "https://staging.elizacloud.ai",
  };
  if (!parsed.HCLOUD_TOKEN && !parsed.HETZNER_CLOUD_TOKEN && !parsed.HETZNER_CLOUD_API_KEY) {
    overlays.HCLOUD_TOKEN = hcloudToken;
  }

  return `${raw.trimEnd()}

# Added by bootstrap-provisioning-worker-host.mjs.
${Object.entries(overlays)
  .map(([key, value]) => `${key}=${quoteEnvValue(value)}`)
  .join("\n")}
`;
}

function quoteEnvValue(value) {
  return `"${String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("$", "\\$")}"`;
}

async function deployWorker(host) {
  log("syncing worker checkout on remote host");
  await ssh(
    host,
    [
      "set -euo pipefail",
      `REPO_URL=${shellQuote(String(values["repo-url"]))}`,
      `DEPLOY_BRANCH=${shellQuote(branch)}`,
      "if [ ! -d /opt/eliza/.git ]; then",
      "  sudo rm -rf /opt/eliza",
      "  sudo install -d -m 0755 -o deploy -g deploy /opt/eliza",
      '  git clone --branch "$DEPLOY_BRANCH" "$REPO_URL" /opt/eliza',
      "fi",
      "cd /opt/eliza",
      'git remote set-url origin "$REPO_URL" || true',
      'git fetch origin "$DEPLOY_BRANCH"',
      'git checkout -B "$DEPLOY_BRANCH" "origin/$DEPLOY_BRANCH"',
      "sudo chown -R deploy:deploy /opt/eliza",
      "if ! command -v bun >/dev/null 2>&1; then",
      '  curl -fsSL https://bun.sh/install | bash -s "bun-v1.3.13"',
      "fi",
      'export BUN_INSTALL="$HOME/.bun"',
      'export PATH="$BUN_INSTALL/bin:$PATH"',
      "for attempt in 1 2 3; do",
      "  if bun install --frozen-lockfile; then break; fi",
      '  if [ "$attempt" -eq 3 ]; then exit 1; fi',
      '  echo "bun install attempt $attempt failed; retrying in 10s..."',
      "  sleep 10",
      "done",
    ].join("\n"),
  );
}

async function restartWorker(host) {
  log("installing and restarting systemd worker");
  await ssh(
    host,
    [
      "set -euo pipefail",
      "cd /opt/eliza",
      "sudo install -m 0644 cloud/packages/scripts/eliza-provisioning-worker.service /etc/systemd/system/eliza-provisioning-worker.service",
      "sudo systemctl daemon-reload",
      "sudo systemctl enable eliza-provisioning-worker.service",
      "sudo systemctl restart eliza-provisioning-worker.service",
    ].join("\n"),
  );
}

async function assertWorkerHealthy(host) {
  log("checking systemd health");
  await ssh(
    host,
    [
      "set -euo pipefail",
      "SINCE_TS=\"$(date -u -d '30 seconds ago' '+%Y-%m-%d %H:%M:%S')\"",
      "for attempt in $(seq 1 18); do",
      "  if sudo systemctl is-active --quiet eliza-provisioning-worker.service; then",
      '    JOURNAL=$(sudo journalctl -u eliza-provisioning-worker.service --since "$SINCE_TS" --no-pager 2>/dev/null || true)',
      "    if echo \"$JOURNAL\" | grep -qE '\\[provisioning-worker\\] (fatal|unhandled rejection)'; then",
      '      echo "$JOURNAL" | tail -n 80',
      "      exit 1",
      "    fi",
      "    if echo \"$JOURNAL\" | grep -q '\\[provisioning-worker\\] starting'; then",
      '      echo "worker is active"',
      "      exit 0",
      "    fi",
      "  fi",
      '  echo "health check attempt $attempt/18"',
      "  sleep 5",
      "done",
      "sudo systemctl status eliza-provisioning-worker.service --no-pager || true",
      "sudo journalctl -u eliza-provisioning-worker.service -n 200 --no-pager || true",
      "exit 1",
    ].join("\n"),
  );
}

async function waitForSsh(host) {
  log("waiting for deploy SSH");
  for (let attempt = 1; attempt <= 60; attempt++) {
    const result = spawnSync("ssh", [...sshCommonArgs(), `deploy@${host}`, "true"]);
    if (result.status === 0) return;
    if (attempt === 60) fail(`Could not connect to deploy@${host} with ${keyPath}.`);
    await sleep(5_000);
  }
}

async function setGitHubSecret(name, value) {
  log(`setting GitHub secret ${name}`);
  await run(
    "gh",
    ["secret", "set", name, "--repo", String(values["github-repo"]), "--env", environment],
    value,
  );
}

async function hcloud(method, path, body) {
  const response = await fetch(`https://api.hetzner.cloud/v1${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${hcloudToken}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (response.status === 204) return {};

  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) {
    const message = data?.error?.message ?? response.statusText;
    fail(`Hetzner API ${method} ${path} failed (${response.status}): ${message}`);
  }
  return data;
}

function sshCommonArgs() {
  return [
    "-i",
    keyPath,
    "-o",
    "BatchMode=yes",
    "-o",
    "IdentitiesOnly=yes",
    "-o",
    "StrictHostKeyChecking=accept-new",
    "-o",
    "ConnectTimeout=10",
  ];
}

async function ssh(host, script) {
  await run("ssh", [...sshCommonArgs(), `deploy@${host}`, "bash -se"], script);
}

function run(command, args, stdin) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, {
      cwd: repoRoot,
      stdio: [stdin ? "pipe" : "ignore", "inherit", "inherit"],
    });
    child.on("error", rejectRun);
    child.on("exit", (code) => {
      if (code === 0) {
        resolveRun();
      } else {
        rejectRun(new Error(`${command} exited with ${code}`));
      }
    });
    if (stdin) {
      child.stdin.write(stdin);
      child.stdin.end();
    }
  }).catch((error) => fail(error.message));
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function log(message) {
  console.log(message);
}

function fail(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}
