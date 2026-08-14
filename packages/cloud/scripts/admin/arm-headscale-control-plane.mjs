#!/usr/bin/env node
/**
 * Arm Headscale on a Hetzner control-plane host.
 *
 * This is the repeatable counterpart to the launch runbook hand edits:
 *   - converge /etc/headscale/config.yaml to the public URL + loopback listener
 *   - install the committed ACL policy
 *   - ensure the `agent` and `tunnel` users exist
 *   - provision the nginx vhost + Let's Encrypt cert that front the canonical
 *     and temporary legacy Headscale names during the eliza.app migration
 *     (TS2021/noise needs a no-http2 vhost with Upgrade/Connection passthrough
 *     + long timeouts — a CF-proxied or h2 origin breaks it)
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

const HEADSCALE_ENVIRONMENT_BY_CANONICAL_HOST = new Map([
  [
    "headscale.eliza.app",
    {
      legacyHostname: "headscale.elizacloud.ai",
      apiUrl: "http://127.0.0.1:8081",
      listenAddr: "127.0.0.1:8081",
    },
  ],
  [
    "headscale-staging.eliza.app",
    {
      legacyHostname: "headscale-staging.elizacloud.ai",
      apiUrl: "http://127.0.0.1:8080",
      listenAddr: "127.0.0.1:8080",
    },
  ],
]);

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

function parseHttpsOrigin(name, value) {
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.username !== "" ||
      url.password !== "" ||
      url.port !== "" ||
      url.pathname !== "/" ||
      url.search !== "" ||
      url.hash !== ""
    ) {
      throw new Error("must be an exact HTTPS origin");
    }
    return url;
  } catch {
    die(`${name} must be an exact HTTPS origin (received ${value})`);
  }
}

const args = parseArgs(process.argv.slice(2));
if (args.help || args.h) {
  console.log(`
Arm Headscale on a control-plane host.

Required:
  --host <ip-or-host>                  Control-plane SSH host.
  --ssh-key <path>                     Deploy-user SSH private key.
  --ssh-known-hosts <path>             Independently verified known_hosts inventory.
  --headscale-public-url <https-url>   Public Headscale URL.
  --headscale-legacy-public-url <url>  Temporary legacy HTTPS overlap URL.
  --headscale-api-key <key>            Existing Headscale API key.

Optional:
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
const sshKnownHosts = readArg(
  args,
  "ssh-known-hosts",
  "DEPLOY_SSH_KNOWN_HOSTS",
);
const publicUrl = readArg(args, "headscale-public-url", "HEADSCALE_PUBLIC_URL");
const legacyPublicUrl = readArg(
  args,
  "headscale-legacy-public-url",
  "HEADSCALE_LEGACY_PUBLIC_URL",
);
const apiKey = readArg(args, "headscale-api-key", "HEADSCALE_API_KEY");
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
if (!sshKnownHosts)
  die("--ssh-known-hosts or DEPLOY_SSH_KNOWN_HOSTS is required");
if (!existsSync(sshKnownHosts))
  die(`SSH known_hosts inventory not found: ${sshKnownHosts}`);
if (!publicUrl)
  die("--headscale-public-url or HEADSCALE_PUBLIC_URL is required");
if (!legacyPublicUrl)
  die(
    "--headscale-legacy-public-url or HEADSCALE_LEGACY_PUBLIC_URL is required",
  );
if (!apiKey) die("--headscale-api-key or HEADSCALE_API_KEY is required");
if (!existsSync(aclPath)) die(`ACL file not found: ${aclPath}`);
const parsedPublicUrl = parseHttpsOrigin("HEADSCALE_PUBLIC_URL", publicUrl);
const parsedLegacyPublicUrl = parseHttpsOrigin(
  "HEADSCALE_LEGACY_PUBLIC_URL",
  legacyPublicUrl,
);

// The canonical hostname selects the whole environment contract. Loopback API
// and listener values are deliberately not operator inputs: accepting an
// external daemon API URL could exfiltrate the protected Headscale bearer key.
const headscaleHostname = parsedPublicUrl.hostname;
const environmentConfig = HEADSCALE_ENVIRONMENT_BY_CANONICAL_HOST.get(
  headscaleHostname,
);
if (!environmentConfig) {
  die(
    `HEADSCALE_PUBLIC_URL must use a canonical Headscale hostname (received ${headscaleHostname})`,
  );
}
const { legacyHostname: expectedLegacyHostname, apiUrl, listenAddr } =
  environmentConfig;
const legacyHeadscaleHostname = parsedLegacyPublicUrl.hostname;
if (legacyHeadscaleHostname !== expectedLegacyHostname) {
  die(
    `HEADSCALE_LEGACY_PUBLIC_URL must be https://${expectedLegacyHostname} for ${headscaleHostname}`,
  );
}
// .pop() on the colon-split yields the port for "addr:port" and the whole
// string for a bare "port" — no need to branch on includes(":").
const headscalePort = listenAddr.split(":").pop();
if (!/^\d+$/.test(headscalePort ?? ""))
  die(`could not derive headscale port from listen_addr '${listenAddr}'`);

// CP router hostname: cp-<env>-router. Derive <env> from the public hostname
// when not given explicitly: headscale-staging.eliza.app → staging,
// headscale.eliza.app → production. Falls back to the literal first DNS
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

// ── nginx vhost + Let's Encrypt migration-overlap certificate ────────────────
// The canonical hostname owns Headscale identity and daemon configuration. The
// legacy exact hostname remains an additive TLS/vhost alias only while clients
// migrate. Both names terminate on the same no-http2 nginx listener because the
// TS2021/noise control protocol needs Upgrade/Connection passthrough and long
// timeouts. Upstream port tracks the Headscale listen_addr.
//
// Cert flow: retain the currently loaded TLS vhost while an earlier-loading,
// HTTP-only webroot vhost answers ACME for both names. A certificate directory
// is not proof of correctness, so every run checks both hostnames against the
// live leaf certificate and expands/reissues when either SAN is absent. The
// final port-80 vhost keeps the webroot challenge path for certbot.timer renewal.
const nginxCertSteps = skipNginxCert
  ? `echo "skip-nginx-cert set: leaving nginx vhost + LE cert untouched"`
  : `
echo "--- nginx vhost + Let's Encrypt cert for ${headscaleHostname} and ${legacyHeadscaleHostname} ---"
HS_HOST=${shellQuote(headscaleHostname)}
HS_LEGACY_HOST=${shellQuote(legacyHeadscaleHostname)}
HS_PORT=${shellQuote(headscalePort)}
CERTBOT_EMAIL=${shellQuote(certbotEmail)}
HS_VHOST=/etc/nginx/conf.d/headscale.conf
HS_ACME_VHOST=/etc/nginx/conf.d/00-headscale-acme.conf
ACME_WEBROOT=/var/lib/letsencrypt
LE_LIVE=/etc/letsencrypt/live/$HS_HOST
LE_FULLCHAIN=$LE_LIVE/fullchain.pem
LE_PRIVKEY=$LE_LIVE/privkey.pem

command -v openssl >/dev/null 2>&1 || { echo "openssl is required to verify Headscale certificate SANs"; exit 1; }
command -v certbot >/dev/null 2>&1 || sudo apt-get install -y certbot

certificate_has_exact_san() {
  sudo test -s "$LE_FULLCHAIN" \\
    && sudo openssl x509 -in "$LE_FULLCHAIN" -noout -ext subjectAltName 2>/dev/null \\
      | tr ',' '\\n' \\
      | sed -n 's/^[[:space:]]*DNS://p' \\
      | grep -Fx -- "$1" >/dev/null
}

certificate_covers_overlap() {
  certificate_has_exact_san "$HS_HOST" \\
    && certificate_has_exact_san "$HS_LEGACY_HOST"
}

if certificate_covers_overlap; then
  echo "LE cert already covers canonical and legacy Headscale hosts; skipping issuance"
else
  sudo install -d -o root -g root -m 0755 "$ACME_WEBROOT"
  HS_ACME_BACKUP=$(mktemp)
  HS_ACME_STAGE=$(mktemp)
  HS_ACME_VHOST_EXISTED=false
  if sudo test -f "$HS_ACME_VHOST"; then
    sudo cp "$HS_ACME_VHOST" "$HS_ACME_BACKUP"
    HS_ACME_VHOST_EXISTED=true
  fi
  tee "$HS_ACME_STAGE" >/dev/null <<NGINX
server {
    listen 80;
    listen [::]:80;
    server_name $HS_HOST $HS_LEGACY_HOST;
    location ^~ /.well-known/acme-challenge/ {
        root $ACME_WEBROOT;
        default_type text/plain;
        try_files \\$uri =404;
    }
    location / { return 404; }
}
NGINX

  restore_acme_vhost() {
    trap - EXIT
    if [ "$HS_ACME_VHOST_EXISTED" = "true" ]; then
      sudo cp "$HS_ACME_BACKUP" "$HS_ACME_VHOST"
    else
      sudo rm -f "$HS_ACME_VHOST"
    fi
    rm -f "$HS_ACME_BACKUP" "$HS_ACME_STAGE"
    sudo nginx -t
    sudo systemctl reload nginx
  }
  trap restore_acme_vhost EXIT

  sudo install -o root -g root -m 0644 "$HS_ACME_STAGE" "$HS_ACME_VHOST"
  sudo nginx -t
  sudo systemctl reload nginx

  certbot_args=(
    certonly
    --webroot
    --webroot-path "$ACME_WEBROOT"
    --non-interactive
    --agree-tos
    --cert-name "$HS_HOST"
    -m "$CERTBOT_EMAIL"
    -d "$HS_HOST"
    -d "$HS_LEGACY_HOST"
  )
  if sudo test -s "$LE_FULLCHAIN"; then
    certbot_args+=(--expand)
  fi
  sudo certbot "\${certbot_args[@]}"

  if ! certificate_covers_overlap; then
    echo "issued Headscale certificate does not cover both required hostnames"
    exit 1
  fi
  restore_acme_vhost
fi

# Final no-http2 TLS vhost: 80→443 redirect + 443 proxy to Headscale
#    loopback listener, with the Upgrade/Connection map + long timeouts the
#    noise protocol needs. Both exact hostnames stay available during migration.
HS_VHOST_BACKUP=$(mktemp)
HS_VHOST_STAGE=$(mktemp)
HS_VHOST_EXISTED=false
if sudo test -f "$HS_VHOST"; then
  sudo cp "$HS_VHOST" "$HS_VHOST_BACKUP"
  HS_VHOST_EXISTED=true
fi

rollback_headscale_vhost() {
  trap - EXIT
  if [ "$HS_VHOST_EXISTED" = "true" ]; then
    sudo cp "$HS_VHOST_BACKUP" "$HS_VHOST"
  else
    sudo rm -f "$HS_VHOST"
  fi
  if sudo nginx -t; then
    sudo systemctl reload nginx
  else
    echo "rollback restored the previous Headscale vhost bytes, but nginx validation failed"
  fi
  rm -f "$HS_VHOST_BACKUP" "$HS_VHOST_STAGE"
}
trap rollback_headscale_vhost EXIT

tee "$HS_VHOST_STAGE" >/dev/null <<NGINX
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
    server_name $HS_HOST $HS_LEGACY_HOST;
    location ^~ /.well-known/acme-challenge/ {
        root $ACME_WEBROOT;
        default_type text/plain;
        try_files \\$uri =404;
    }
    location / { return 301 https://\\$host\\$request_uri; }
}
server {
    listen 443 ssl;
    listen [::]:443 ssl;
    server_name $HS_HOST $HS_LEGACY_HOST;
    ssl_certificate     $LE_FULLCHAIN;
    ssl_certificate_key $LE_PRIVKEY;
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
sudo install -o root -g root -m 0644 "$HS_VHOST_STAGE" "$HS_VHOST"
sudo nginx -t

effective_nginx_config=$(sudo nginx -T 2>&1)
overlap_warnings=$(printf '%s\n' "$effective_nginx_config" \
  | grep -F 'conflicting server name' \
  | grep -F -e "$HS_HOST" -e "$HS_LEGACY_HOST" || true)
hostname_owners=$(printf '%s\n' "$effective_nginx_config" | awk \
  -v canonical="$HS_HOST" \
  -v legacy="$HS_LEGACY_HOST" '
  function inspect_names(text, fields, count, i, name) {
    count = split(text, fields, /[[:space:]]+/)
    for (i = 1; i <= count; i += 1) {
      name = fields[i]
      if (name == "") continue
      if (name ~ /;$/) collecting = 0
      sub(/;$/, "", name)
      gsub(/^"|"$/, "", name)
      if (name == canonical || name == legacy) print config_file "\t" name
    }
  }
  /^# configuration file / {
    config_file = $0
    sub(/^# configuration file /, "", config_file)
    sub(/:$/, "", config_file)
    collecting = 0
    next
  }
  {
    line = $0
    sub(/[[:space:]]*#.*/, "", line)
    if (collecting) {
      inspect_names(line)
      next
    }
    if (line ~ /^[[:space:]]*server_name[[:space:]]+/) {
      sub(/^[[:space:]]*server_name[[:space:]]+/, "", line)
      collecting = 1
      inspect_names(line)
    }
  }
')
unexpected_owners=$(printf '%s\n' "$hostname_owners" \
  | awk -F '\t' -v expected="$HS_VHOST" 'NF == 2 && $1 != expected { print }')
canonical_owner_count=$(printf '%s\n' "$hostname_owners" \
  | awk -F '\t' -v host="$HS_HOST" '$2 == host { count += 1 } END { print count + 0 }')
legacy_owner_count=$(printf '%s\n' "$hostname_owners" \
  | awk -F '\t' -v host="$HS_LEGACY_HOST" '$2 == host { count += 1 } END { print count + 0 }')
if [ -n "$overlap_warnings" ] \
    || [ -n "$unexpected_owners" ] \
    || [ "$canonical_owner_count" -ne 2 ] \
    || [ "$legacy_owner_count" -ne 2 ]; then
  if [ -n "$overlap_warnings" ]; then
    echo "nginx reported conflicting Headscale server names:"
    printf '%s\n' "$overlap_warnings"
  fi
  echo "Headscale hostname ownership is not exclusive to $HS_VHOST:"
  printf '%s\n' "$hostname_owners"
  echo "Leaving unknown nginx configs untouched and restoring the prior $HS_VHOST"
  exit 1
fi

certificate_has_exact_san "$HS_HOST"
certificate_has_exact_san "$HS_LEGACY_HOST"
sudo systemctl reload nginx

rm -f "$HS_VHOST_BACKUP" "$HS_VHOST_STAGE"
trap - EXIT

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

if ! getent group headscale >/dev/null; then
  sudo groupadd --system headscale
fi
if ! id -u headscale >/dev/null 2>&1; then
  sudo useradd \\
    --system \\
    --gid headscale \\
    --home-dir ${HEADSCALE_STATE_DIR} \\
    --no-create-home \\
    --shell /usr/sbin/nologin \\
    headscale
elif ! id -nG headscale | grep -Eq '(^|[[:space:]])headscale([[:space:]]|$)'; then
  echo "existing headscale user is not a member of the headscale group"
  exit 1
fi

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
    "StrictHostKeyChecking=yes",
    "-o",
    `UserKnownHostsFile=${sshKnownHosts}`,
    "-o",
    "GlobalKnownHostsFile=/dev/null",
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
