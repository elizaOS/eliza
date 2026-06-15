#!/usr/bin/env node
/**
 * Arm the apps (Product 2) deploy backend on a provisioning-worker control
 * plane — idempotently, over SSH, no hand-editing the box.
 *
 * The daemon (`provisioning-worker.ts`) already calls
 * `configureAppsDeployBackend()` on boot, but it only actually provisions app
 * containers once the apps env is present in `/opt/eliza/cloud/.env.local`
 * (`appsContainersEnabled()` gates on CONTAINERS_DOCKER_NODES + an SSH key,
 * and the deploy runner needs the tenant admin DSN + ingress URL). This script
 * UPSERTS exactly that block into the env file (each key set-or-replaced, never
 * duplicated, every other line untouched), then restarts the daemon — so it is
 * safe to re-run and leaves the agent/coding fleet config alone.
 *
 * IaC, not manual: the values come from flags / the apps-shared + per-env
 * terraform outputs, so re-running after an infra change re-converges the box.
 *
 * Usage:
 *   node packages/scripts/cloud/admin/arm-apps-daemon.mjs \
 *     --host <control-plane-ip> \
 *     --ssh-key <path-to-key-for-the-cp-deploy-user> \
 *     --app-node <id:ip:capacity>            # e.g. apps-node-1:167.233.112.155:20
 *     --base-domain apps-staging.elizacloud.ai \
 *     --caddy-admin http://167.233.112.155:2019 \
 *     --tenant-admin-dsn 'postgresql://postgres:***@10.30.1.10:5432/postgres?sslmode=require' \
 *     --node-ssh-key-path /home/deploy/.ssh/apps-node \   # key the APP NODE's deploy user accepts
 *     [--node-ssh-user deploy] [--egress-proxy http://127.0.0.1:3128] [--dry-run]
 *
 * Re-run with the same args = no-op (env already converged) + a daemon restart.
 */

import { spawnSync } from "node:child_process";

const ENV_PATH = "/opt/eliza/cloud/.env.local";
const SYSTEMD_UNIT = "eliza-provisioning-worker.service";

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      out[key] = true;
    } else {
      out[key] = next;
      i += 1;
    }
  }
  return out;
}

function die(msg) {
  console.error(`error: ${msg}`);
  process.exit(1);
}

const args = parseArgs(process.argv.slice(2));

const host = args.host;
const sshKey = args["ssh-key"];
if (!host) die("--host <control-plane-ip> is required");
if (!sshKey)
  die("--ssh-key <path> is required (a key the CP's deploy user accepts)");

// The apps env block the daemon needs. Only keys with a value are written;
// CONTAINERS_DOCKER_NODES is intentionally NOT overwritten if --app-node is
// omitted, so an operator can layer this onto a box that already has it set
// (and we never clobber an agent-fleet value by accident — see the guard).
const desired = {
  // Arms the APP_DEPLOY runner (DefaultAppDeployRunner). Without this the daemon's
  // armAppsDeployBackendIfEnabled() early-returns (provisioning-worker.ts:652) and
  // APP_DEPLOY jobs are enqueued but never claimed — apps stay stuck "building".
  APPS_DEPLOY_ENABLED: "1",
  // Arms the container executor backend (AppContainerProvider over docker-over-SSH).
  APPS_CONTAINERS_ENABLED: "1",
  CONTAINERS_DOCKER_NODES: args["app-node"],
  CONTAINERS_SSH_USER: args["node-ssh-user"] || "deploy",
  CONTAINERS_SSH_KEY_PATH: args["node-ssh-key-path"],
  APPS_CADDY_ADMIN_URL: args["caddy-admin"],
  CONTAINERS_PUBLIC_BASE_DOMAIN: args["base-domain"],
  APPS_TENANT_ADMIN_DSN: args["tenant-admin-dsn"],
  CONTAINERS_EGRESS_PROXY_URL: args["egress-proxy"],
};

const entries = Object.entries(desired).filter(
  ([, v]) => typeof v === "string" && v.length > 0,
);
if (!entries.find(([k]) => k === "CONTAINERS_DOCKER_NODES")) {
  console.warn(
    "warning: no --app-node given; CONTAINERS_DOCKER_NODES will be left as-is on the box.\n" +
      "         (provide it unless the box already targets the apps node.)",
  );
}

// Build a remote bash script that upserts each key with a here-doc-safe sed,
// preserving every other line. Each value is single-quoted for the env file and
// shell-escaped for the remote command.
function shEscape(s) {
  return `'${String(s).replaceAll("'", `'\\''`)}'`;
}
function envValueQuote(v) {
  // env.local values may contain '@', '?', '/', etc. (DSN); double-quote them and
  // escape embedded double quotes + backslashes so the daemon's dotenv reads them whole.
  return `"${String(v).replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

const upserts = entries
  .map(([k, v]) => {
    const line = `${k}=${envValueQuote(v)}`;
    // delete any existing definition of the key, then append the fresh one.
    return [
      `grep -q ${shEscape(`^${k}=`)} "$F" && sed -i ${shEscape(`/^${k}=/d`)} "$F" || true`,
      `printf '%s\\n' ${shEscape(line)} >> "$F"`,
    ].join("\n");
  })
  .join("\n");

const remote = `
set -euo pipefail
F=${ENV_PATH}
[ -f "$F" ] || { echo "env file $F not found on host"; exit 1; }
cp -n "$F" "$F.bak.arm-apps" 2>/dev/null || true
${upserts}
echo "--- apps env now on the box ---"
grep -E '^(APPS_|CONTAINERS_(DOCKER_NODES|SSH_USER|SSH_KEY_PATH|PUBLIC_BASE_DOMAIN|EGRESS_PROXY_URL))' "$F" | sed -E 's/(DSN|KEY)=.*/\\1=<redacted>/'
sudo systemctl restart ${SYSTEMD_UNIT}
sleep 2
echo "--- daemon status ---"
systemctl is-active ${SYSTEMD_UNIT}
journalctl -u ${SYSTEMD_UNIT} -n 8 --no-pager | tail -8 || true
`;

if (args["dry-run"]) {
  console.log("# DRY RUN — remote script that WOULD run on", host, ":\n");
  console.log(remote);
  process.exit(0);
}

console.log(`arming apps daemon on ${host} (idempotent upsert + restart)…`);
const res = spawnSync(
  "ssh",
  [
    "-i",
    sshKey,
    "-o",
    "IdentitiesOnly=yes",
    "-o",
    "StrictHostKeyChecking=accept-new",
    "-o",
    "ConnectTimeout=15",
    `deploy@${host}`,
    "bash -s",
  ],
  { input: remote, stdio: ["pipe", "inherit", "inherit"] },
);

if (res.status !== 0) {
  die(`remote arming failed (exit ${res.status})`);
}
console.log(
  "\n✅ apps daemon armed. next: trigger a sample app deploy and watch it serve.",
);
