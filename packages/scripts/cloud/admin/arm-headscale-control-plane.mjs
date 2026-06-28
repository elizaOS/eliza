#!/usr/bin/env node
/**
 * Arm Headscale on a Hetzner control-plane host.
 *
 * This is the repeatable counterpart to the launch runbook hand edits:
 *   - converge /etc/headscale/config.yaml to the public URL + loopback listener
 *   - install the committed ACL policy
 *   - ensure the `agent` and `tunnel` users exist
 *   - provision the nginx vhost + Let's Encrypt cert that fronts the public
 *     Headscale URL (TS2021/noise needs a no-http2 vhost with Upgrade/Connection
 *     passthrough + long timeouts — a CF-proxied or h2 origin breaks it)
 *   - enroll the CP itself as a tailscale node (cp-<env>-router, tag:eliza-proxy)
 *     against its local Headscale, so the daemon can reach agent 100.64.x IPs
 *   - upsert the daemon env that makes sandbox provisioning require Headscale
 *   - restart Headscale and the provisioning worker, then health-check both
 *
 * These last-mile bits (nginx vhost, LE cert, cp-router enrollment) were
 * previously hand-run on every CP and lost on a rebuild — that DR gap is what
 * this script + the control-plane Terraform headscale DNS record now close.
 * Every step here is idempotent: a re-arm is a no-op if the box is converged.
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
  "packages/cloud/services/headscale/acl.hujson",
);

// Only these flags take no value. Every other flag consumes the next token as
// its value — even one that starts with "--" (a PEM begins with "-----BEGIN"),
// which a naive next.startsWith("--") check would silently drop.
const BOOL_FLAGS = new Set([
  "dry-run",
  "help",
  "h",
  "skip-nginx-cert",
  "skip-cp-router",
]);

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith("--") && a !== "-h") continue;
    const key = a.replace(/^--?/, "");
    if (BOOL_FLAGS.has(key)) {
      out[key] = true;
      continue;
    }
    const next = argv[i + 1];
    if (next === undefined) {
      out[key] = true;
    } else {
      out[key] = next;
      i += 1;
    }
  }
  return out;
}

function readArg(args, key, envKey) {
  // A flag parsed without a value yields boolean true; ignore it so the env
  // fallback is still reachable (never treat true as a real string value).
  const fromArg = typeof args[key] === "string" ? args[key] : undefined;
  const value =
    fromArg ?? process.env[envKey ?? key.toUpperCase().replaceAll("-", "_")];
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
  --cp-router-hostname <name>          Tailscale hostname the CP enrolls itself as
                                       (default derived from the public URL, e.g.
                                       cp-staging-router). tag:eliza-proxy, owned
                                       by the 'tunnel' headscale user.
  --certbot-email <email>              Email for the Let's Encrypt account / expiry
                                       notices (default ops@elizalabs.ai).
  --skip-nginx-cert                    Skip the nginx vhost + LE cert step.
  --skip-cp-router                     Skip the CP self-enrollment step.
  --agent-token-private-key-pem <pem>  Upsert daemon env when already generated.
  --eliza-local-root-key <key>         Upsert daemon env when already generated.
  --dry-run                            Print remote script, do not SSH.

Environment fallbacks use uppercase option names, e.g. HEADSCALE_API_KEY.

WARNING: --dry-run prints the assembled remote script INCLUDING secret values
(HEADSCALE_API_KEY / AGENT_TOKEN_PRIVATE_KEY_PEM / ELIZA_LOCAL_ROOT_KEY) in
plaintext. Do not run it in a shared or logged terminal. Prefer env vars over
CLI flags for secret material.
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
const certbotEmail =
  readArg(args, "certbot-email", "CERTBOT_EMAIL") ?? "ops@elizalabs.ai";
const cpRouterHostnameArg = readArg(
  args,
  "cp-router-hostname",
  "CP_ROUTER_HOSTNAME",
);
const skipNginxCert = args["skip-nginx-cert"] === true;
const skipCpRouter = args["skip-cp-router"] === true;

if (!host) die("--host or DEPLOY_HOST is required");
if (!sshKey) die("--ssh-key or DEPLOY_SSH_KEY is required");
if (!existsSync(sshKey)) die(`SSH key not found: ${sshKey}`);
if (!publicUrl)
  die("--headscale-public-url or HEADSCALE_PUBLIC_URL is required");
if (!apiKey) die("--headscale-api-key or HEADSCALE_API_KEY is required");
if (!existsSync(aclPath)) die(`ACL file not found: ${aclPath}`);
validateHttpsUrl("HEADSCALE_PUBLIC_URL", publicUrl);

// The nginx vhost fronts the public hostname (host part of the URL) and proxies
// to the loopback port headscale listens on (port part of listen_addr). Both
// are already env-correct on the workflow inputs — staging is :8080, prod :8081
// — so the vhost upstream tracks listen_addr automatically with no extra flag.
const headscaleHostname = new URL(publicUrl).hostname;
// .pop() on the colon-split yields the port for "addr:port" and the whole
// string for a bare "port" — no need to branch on includes(":").
const headscalePort = listenAddr.split(":").pop();
if (!/^\d+$/.test(headscalePort ?? ""))
  die(`could not derive headscale port from listen_addr '${listenAddr}'`);

// CP router hostname: cp-<env>-router. Derive <env> from the public hostname
// when not given explicitly: headscale-staging.elizacloud.ai → staging,
// headscale.elizacloud.ai → production. Falls back to the literal first DNS
// label otherwise, so an unexpected hostname still yields a deterministic name
// rather than throwing.
function deriveCpRouterHostname(fqdn) {
  const firstLabel = fqdn.split(".")[0]; // "headscale-staging" | "headscale"
  const suffix = firstLabel.startsWith("headscale-")
    ? firstLabel.slice("headscale-".length)
    : firstLabel === "headscale"
      ? "production"
      : firstLabel;
  return `cp-${suffix}-router`;
}
const cpRouterHostname =
  cpRouterHostnameArg ?? deriveCpRouterHostname(headscaleHostname);

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

// ── nginx vhost + Let's Encrypt cert for the public Headscale URL ────────────
// Reproduces the proven-good /etc/nginx/conf.d/headscale.conf that was hand-
// written on each CP (the DR gap). The vhost MUST be no-http2 with Upgrade/
// Connection passthrough + 86400s timeouts — the headscale TS2021/noise control
// protocol rides a long-lived HTTP/1.1 Upgrade that an h2 origin (RFC 7540) or
// a short proxy timeout drops. Upstream port tracks the headscale listen_addr.
//
// Cert flow: write an HTTP-only bootstrap vhost so certbot's nginx authenticator
// can solve HTTP-01, run `certbot certonly` (idempotent — no-op if a valid cert
// already exists), THEN drop the final TLS vhost referencing the LE cert paths.
// `certonly` (not `--nginx` install) keeps the final vhost fully deterministic
// here instead of letting certbot rewrite it. Renewal is certbot's own
// systemd certbot.timer (installed by the certbot package) — no cron added.
const nginxCertSteps = skipNginxCert
  ? `echo "skip-nginx-cert set: leaving nginx vhost + LE cert untouched"`
  : `
echo "--- nginx vhost + Let's Encrypt cert for ${headscaleHostname} ---"
HS_HOST=${shellQuote(headscaleHostname)}
HS_PORT=${shellQuote(headscalePort)}
CERTBOT_EMAIL=${shellQuote(certbotEmail)}
HS_VHOST=/etc/nginx/conf.d/headscale.conf
LE_LIVE=/etc/letsencrypt/live/$HS_HOST

command -v certbot >/dev/null 2>&1 || sudo apt-get install -y certbot python3-certbot-nginx

# 1. Bootstrap HTTP-only vhost so certbot --nginx can answer the HTTP-01
#    challenge on :80. Overwritten by the final vhost below once the cert
#    exists. Idempotent: re-running just rewrites the same bytes.
sudo tee "$HS_VHOST" >/dev/null <<NGINX
server {
    listen 80;
    listen [::]:80;
    server_name $HS_HOST;
    location / { return 404; }
}
NGINX
sudo nginx -t
sudo systemctl reload nginx

# 2. Obtain the cert if absent / not yet valid. certonly is idempotent and
#    exits 0 when a live cert is already present and not near expiry, so a
#    re-arm never re-issues (and never trips LE rate limits). --nginx
#    authenticator reuses the running nginx for the HTTP-01 challenge.
if sudo test -d "$LE_LIVE"; then
  echo "LE cert already present for $HS_HOST; skipping issuance"
else
  sudo certbot certonly --nginx --non-interactive --agree-tos \\
    -m "$CERTBOT_EMAIL" -d "$HS_HOST"
fi

# 3. Final no-http2 TLS vhost: 80→443 redirect + 443 proxy to the headscale
#    loopback listener, with the Upgrade/Connection map + long timeouts the
#    noise protocol needs. This is the byte-for-byte proven-good prod/staging
#    vhost, templated for env hostname + port.
sudo tee "$HS_VHOST" >/dev/null <<NGINX
# headscale control-protocol (TS2021/noise) needs the Upgrade header passed
# through on HTTP/1.1. NO http2 on this vhost: an h2 client connection would
# drop the Upgrade header (RFC 7540), which is exactly what broke headscale
# on Railway.
map \\$http_upgrade \\$hs_connection_upgrade {
    default upgrade;
    ''      close;
}
server {
    listen 80;
    listen [::]:80;
    server_name $HS_HOST;
    return 301 https://\\$host\\$request_uri;
}
server {
    listen 443 ssl;
    listen [::]:443 ssl;
    server_name $HS_HOST;
    ssl_certificate     /etc/letsencrypt/live/$HS_HOST/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/$HS_HOST/privkey.pem;
    location / {
        proxy_pass http://127.0.0.1:$HS_PORT;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \\$http_upgrade;
        proxy_set_header Connection \\$hs_connection_upgrade;
        proxy_set_header Host \\$host;
        proxy_set_header X-Real-IP \\$remote_addr;
        proxy_set_header X-Forwarded-For \\$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \\$scheme;
        proxy_buffering off;
        proxy_read_timeout 86400s;
        proxy_send_timeout 86400s;
    }
}
NGINX
sudo nginx -t
sudo systemctl reload nginx

# Confirm the cert renewal timer is active (renewal is certbot's own systemd
# timer, not a cron entry we manage). Non-fatal: surfaces a warning if the
# distro shipped certbot without the timer.
sudo systemctl is-active certbot.timer >/dev/null 2>&1 \\
  && echo "certbot.timer active (auto-renewal wired)" \\
  || echo "WARN: certbot.timer not active — check auto-renewal on this host"
`;

// ── CP self-enrollment as a tailscale node (cp-<env>-router) ─────────────────
// The CP enrolls ITSELF against its local headscale as cp-<env>-router with
// tag:eliza-proxy (owned by the 'tunnel' user in acl.hujson). This is what lets
// the daemon on the CP reach agent tag:agent 100.64.x IPs. Previously a manual
// `tailscale up` per CP (the DR gap). Idempotent: skips if a node with this
// hostname is already enrolled. headscale v0.28's `preauthkeys create -u` takes
// a numeric USER ID, not a username, so we resolve tunnel→id from users list.
const cpRouterSteps = skipCpRouter
  ? `echo "skip-cp-router set: leaving CP tailscale enrollment untouched"`
  : `
echo "--- CP self-enrollment: ${cpRouterHostname} (tag:eliza-proxy) ---"
CP_ROUTER_HOST=${shellQuote(cpRouterHostname)}
LOGIN_SERVER=${shellQuote(publicUrl)}

command -v tailscale >/dev/null 2>&1 || curl -fsSL https://tailscale.com/install.sh | sh
sudo systemctl enable --now tailscaled

# Already enrolled under this hostname? (matches the live cp-router node by
# headscale node 'name'). If so, this whole step is a no-op.
if sudo headscale nodes list -o json 2>/dev/null \\
    | jq -e --arg h "$CP_ROUTER_HOST" 'any(.[]; .name == $h)' >/dev/null 2>&1; then
  echo "$CP_ROUTER_HOST already enrolled in headscale; skipping tailscale up"
else
  # Resolve the 'tunnel' user id (preauthkeys create -u wants a uint in v0.28).
  TUNNEL_UID=$(sudo headscale users list -o json 2>/dev/null \\
    | jq -r '.[] | select(.name == "tunnel") | .id')
  [ -n "$TUNNEL_UID" ] || { echo "tunnel user not found; cannot mint preauth key"; exit 1; }

  # Short-lived, single-use, pre-tagged preauth key. Tagged tag:eliza-proxy so
  # the node lands tagged at join (ownership enforced by acl.hujson tagOwners).
  PREAUTH_KEY=$(sudo headscale preauthkeys create -u "$TUNNEL_UID" \\
    --tags tag:eliza-proxy --expiration 1h -o json 2>/dev/null | jq -r '.key')
  [ -n "$PREAUTH_KEY" ] || { echo "failed to mint preauth key for cp-router"; exit 1; }

  sudo tailscale up \\
    --login-server="$LOGIN_SERVER" \\
    --authkey="$PREAUTH_KEY" \\
    --hostname="$CP_ROUTER_HOST" \\
    --advertise-tags=tag:eliza-proxy \\
    --accept-routes
  echo "$CP_ROUTER_HOST enrolled"
fi

sudo tailscale status 2>/dev/null | grep -F "$CP_ROUTER_HOST" \\
  || echo "WARN: $CP_ROUTER_HOST not visible in tailscale status yet"
`;

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

# jq is needed by the cp-router enrollment below (and is already a cloud-init
# package on the CP); guard so a stripped host still fails loud, not silent.
command -v jq >/dev/null 2>&1 || sudo apt-get install -y jq

${nginxCertSteps}

${cpRouterSteps}

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
