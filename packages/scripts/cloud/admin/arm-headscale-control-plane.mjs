#!/usr/bin/env node
/**
 * Arm Headscale on a Hetzner control-plane host.
 *
 * This is the repeatable counterpart to the launch runbook hand edits:
 *   - converge /etc/headscale/config.yaml to the public URL + loopback listener
 *   - install the committed ACL policy
 *   - ensure the `agent` and `tunnel` users exist
 *   - upsert the daemon env that makes sandbox provisioning require Headscale
 *   - restart Headscale and the provisioning worker, then health-check both
 *
 * The API key is treated as pre-existing secret material. Generate or rotate it
 * on the box with `headscale apikeys create --expiration=8760h`, then pass it
 * through --headscale-api-key or HEADSCALE_API_KEY. This script never creates or
 * prints a fresh key because GitHub Actions logs are the wrong place for that.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ENV_PATH = "/opt/eliza/cloud/.env.local";
const HEADSCALE_CONFIG = "/etc/headscale/config.yaml";
const HEADSCALE_ACL = "/etc/headscale/acl.hujson";
const HEADSCALE_STATE_DIR = "/var/lib/headscale";
const SYSTEMD_UNIT = "eliza-provisioning-worker.service";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "../../../..");
const aclPath = resolve(
  repoRoot,
  "packages/cloud-services/headscale/acl.hujson",
);

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

function readArg(args, key, envKey) {
  const value =
    args[key] ?? process.env[envKey ?? key.toUpperCase().replaceAll("-", "_")];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function die(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

function envValueQuote(value) {
  // systemd EnvironmentFile values must stay single-line. Agent-token PEM
  // parsing intentionally expands literal "\\n" sequences back to newlines.
  return `"${String(value)
    .replaceAll("\r\n", "\\n")
    .replaceAll("\n", "\\n")
    .replaceAll('"', '\\"')}"`;
}

function validateHttpsUrl(name, value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") throw new Error("must be https");
  } catch {
    die(`${name} must be an https URL (received ${value})`);
  }
}

const args = parseArgs(process.argv.slice(2));
if (args.help || args.h) {
  console.log(`
Arm Headscale on a control-plane host.

Required:
  --host <ip-or-host>                  Control-plane SSH host.
  --ssh-key <path>                     Deploy-user SSH private key.
  --headscale-public-url <https-url>   Public Headscale URL.
  --headscale-api-key <key>            Existing Headscale API key.

Optional:
  --headscale-api-url <url>            Daemon API URL (default http://127.0.0.1:8081).
  --listen-addr <addr:port>            Headscale listen_addr (default 127.0.0.1:8081).
  --headscale-user <user>              User for agent preauth keys (default agent).
  --agent-token-private-key-pem <pem>  Upsert daemon env when already generated.
  --eliza-local-root-key <key>         Upsert daemon env when already generated.
  --dry-run                            Print remote script, do not SSH.

Environment fallbacks use uppercase option names, e.g. HEADSCALE_API_KEY.
`);
  process.exit(0);
}

const host = readArg(args, "host", "DEPLOY_HOST");
const sshKey = readArg(args, "ssh-key", "DEPLOY_SSH_KEY");
const publicUrl = readArg(args, "headscale-public-url", "HEADSCALE_PUBLIC_URL");
const apiUrl =
  readArg(args, "headscale-api-url", "HEADSCALE_API_URL") ??
  "http://127.0.0.1:8081";
const apiKey = readArg(args, "headscale-api-key", "HEADSCALE_API_KEY");
const listenAddr =
  readArg(args, "listen-addr", "HEADSCALE_LISTEN_ADDR") ?? "127.0.0.1:8081";
const headscaleUser =
  readArg(args, "headscale-user", "HEADSCALE_USER") ?? "agent";
const agentTokenPrivateKey = readArg(
  args,
  "agent-token-private-key-pem",
  "AGENT_TOKEN_PRIVATE_KEY_PEM",
);
const localRootKey = readArg(
  args,
  "eliza-local-root-key",
  "ELIZA_LOCAL_ROOT_KEY",
);

if (!host) die("--host or DEPLOY_HOST is required");
if (!sshKey) die("--ssh-key or DEPLOY_SSH_KEY is required");
if (!existsSync(sshKey)) die(`SSH key not found: ${sshKey}`);
if (!publicUrl)
  die("--headscale-public-url or HEADSCALE_PUBLIC_URL is required");
if (!apiKey) die("--headscale-api-key or HEADSCALE_API_KEY is required");
if (!existsSync(aclPath)) die(`ACL file not found: ${aclPath}`);
validateHttpsUrl("HEADSCALE_PUBLIC_URL", publicUrl);

const aclBase64 = Buffer.from(readFileSync(aclPath, "utf8"), "utf8").toString(
  "base64",
);

const daemonEnv = {
  HEADSCALE_PUBLIC_URL: publicUrl,
  HEADSCALE_API_URL: apiUrl,
  HEADSCALE_API_KEY: apiKey,
  HEADSCALE_USER: headscaleUser,
  ...(agentTokenPrivateKey
    ? { AGENT_TOKEN_PRIVATE_KEY_PEM: agentTokenPrivateKey }
    : {}),
  ...(localRootKey ? { ELIZA_LOCAL_ROOT_KEY: localRootKey } : {}),
};

const upserts = Object.entries(daemonEnv)
  .map(([key, value]) => {
    const line = `${key}=${envValueQuote(value)}`;
    return [
      `sudo sed -i ${shellQuote(`/^${key}=/d`)} "$F"`,
      `printf '%s\\n' ${shellQuote(line)} | sudo tee -a "$F" >/dev/null`,
    ].join("\n");
  })
  .join("\n");

const remote = `
set -euo pipefail
PUBLIC_URL=${shellQuote(publicUrl)}
API_URL=${shellQuote(apiUrl)}
LISTEN_ADDR=${shellQuote(listenAddr)}
F=${ENV_PATH}

command -v headscale >/dev/null 2>&1 || {
  echo "headscale binary not found; install the headscale package before arming this host"
  exit 1
}

sudo install -d -m 0755 /etc/headscale
sudo install -d -o headscale -g headscale -m 0750 ${HEADSCALE_STATE_DIR}

printf '%s' ${shellQuote(aclBase64)} | base64 -d | sudo tee ${HEADSCALE_ACL} >/dev/null
sudo chown root:root ${HEADSCALE_ACL}
sudo chmod 0644 ${HEADSCALE_ACL}

if [ ! -f ${HEADSCALE_CONFIG} ]; then
  sudo tee ${HEADSCALE_CONFIG} >/dev/null <<'YAML'
noise:
  private_key_path: /var/lib/headscale/noise_private.key
prefixes:
  v4: 100.64.0.0/10
  v6: fd7a:115c:a1e0::/48
derp:
  urls:
    - https://controlplane.tailscale.com/derpmap/default
  auto_update_enabled: true
  update_frequency: 24h
disable_check_updates: true
ephemeral_node_inactivity_timeout: 15m
node_update_check_interval: 10s
database:
  type: sqlite
  sqlite:
    path: /var/lib/headscale/db.sqlite
    write_ahead_log: true
log:
  level: info
  format: json
dns:
  magic_dns: true
  base_domain: tunnel.eliza.local
  nameservers:
    global:
      - 1.1.1.1
      - 9.9.9.9
policy:
  mode: file
  path: /etc/headscale/acl.hujson
unix_socket: /var/lib/headscale/headscale.sock
unix_socket_permission: "0770"
YAML
fi

set_config() {
  local key="$1"
  local value="$2"
  if sudo grep -qE "^$key:" ${HEADSCALE_CONFIG}; then
    sudo sed -i -E "s|^$key:.*|$key: $value|" ${HEADSCALE_CONFIG}
  else
    printf '%s: %s\\n' "$key" "$value" | sudo tee -a ${HEADSCALE_CONFIG} >/dev/null
  fi
}

set_config server_url "$PUBLIC_URL"
set_config listen_addr "$LISTEN_ADDR"
set_config metrics_listen_addr "127.0.0.1:9090"
set_config grpc_listen_addr "127.0.0.1:50443"
set_config grpc_allow_insecure "false"

sudo grep -qE '^policy:' ${HEADSCALE_CONFIG} || sudo tee -a ${HEADSCALE_CONFIG} >/dev/null <<'YAML'
policy:
  mode: file
  path: /etc/headscale/acl.hujson
YAML

sudo chown root:headscale ${HEADSCALE_CONFIG} || true
sudo chmod 0640 ${HEADSCALE_CONFIG} || true
sudo systemctl enable --now headscale
sudo systemctl restart headscale

for attempt in $(seq 1 30); do
  if curl -sf -m 3 "$API_URL/health" >/dev/null; then
    echo "headscale local health passed on attempt $attempt"
    break
  fi
  if [ "$attempt" = 30 ]; then
    echo "headscale local health failed"
    sudo systemctl status headscale --no-pager || true
    sudo journalctl -u headscale -n 80 --no-pager || true
    exit 1
  fi
  sleep 2
done

for user in agent tunnel; do
  if ! sudo headscale users list -o json 2>/dev/null | grep -q "\\"name\\"[[:space:]]*:[[:space:]]*\\"$user\\""; then
    sudo headscale users create "$user"
  fi
done

sudo test -f "$F" || { echo "env file $F not found on host"; exit 1; }
sudo cp -n "$F" "$F.bak.arm-headscale" 2>/dev/null || true
${upserts}

echo "--- headscale env now on the box (secrets redacted) ---"
sudo grep -E '^(HEADSCALE_|AGENT_TOKEN_PRIVATE_KEY_PEM|ELIZA_LOCAL_ROOT_KEY)' "$F" \\
  | sed -E 's/(KEY|PEM)=.*/\\1=<redacted>/'

sudo systemctl restart ${SYSTEMD_UNIT}
sleep 2
systemctl is-active headscale
systemctl is-active ${SYSTEMD_UNIT}
`;

if (args["dry-run"]) {
  console.log("# DRY RUN - remote script that WOULD run on", host, ":\n");
  console.log(remote);
  process.exit(0);
}

const result = spawnSync(
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

if (result.status !== 0)
  die(`remote Headscale arm failed (exit ${result.status})`);

console.log(
  "\nHeadscale armed. Next: set matching Worker secrets, then run one provision E2E.",
);
