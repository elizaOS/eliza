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
 *   - enroll the CP itself as a tailscale node (cp-<env>-router, tag:eliza-cp)
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
      retirableLegacyVhost: undefined,
    },
  ],
  [
    "headscale-staging.eliza.app",
    {
      legacyHostname: "headscale-staging.elizacloud.ai",
      apiUrl: "http://127.0.0.1:8080",
      listenAddr: "127.0.0.1:8080",
      retirableLegacyVhost: "/etc/nginx/conf.d/headscale-staging.conf",
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
  "inspect-retirable-legacy-vhost",
  "retire-retirable-legacy-vhost",
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
                                       cp-staging-router). tag:eliza-cp, owned
                                       by the 'tunnel' headscale user.
  --certbot-email <email>              Email for the Let's Encrypt account / expiry
                                       notices (default ops@elizalabs.ai).
  --inspect-retirable-legacy-vhost     Read-only validation/report for the exact
                                       environment-derived legacy nginx file.
  --retire-retirable-legacy-vhost      Retire that reviewed file transactionally
                                       while installing the canonical vhost.
  --retirable-legacy-vhost-sha256 <h>  Exact lowercase SHA-256 emitted by the
                                       read-only inspection; required to retire.
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
const inspectRetirableLegacyVhost =
  args["inspect-retirable-legacy-vhost"] === true;
const retireRetirableLegacyVhost =
  args["retire-retirable-legacy-vhost"] === true;
const reviewedLegacyVhostSha256 = readArg(
  args,
  "retirable-legacy-vhost-sha256",
);

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
const environmentConfig =
  HEADSCALE_ENVIRONMENT_BY_CANONICAL_HOST.get(headscaleHostname);
if (!environmentConfig) {
  die(
    `HEADSCALE_PUBLIC_URL must use a canonical Headscale hostname (received ${headscaleHostname})`,
  );
}
const {
  legacyHostname: expectedLegacyHostname,
  apiUrl,
  listenAddr,
  retirableLegacyVhost,
} = environmentConfig;
if (inspectRetirableLegacyVhost && retireRetirableLegacyVhost) {
  die("legacy vhost inspection and retirement modes are mutually exclusive");
}
if (retireRetirableLegacyVhost && skipNginxCert) {
  die("legacy vhost retirement cannot be combined with --skip-nginx-cert");
}
if (
  retireRetirableLegacyVhost &&
  !/^[0-9a-f]{64}$/.test(reviewedLegacyVhostSha256 ?? "")
) {
  die(
    "--retirable-legacy-vhost-sha256 must be the exact lowercase SHA-256 from inspection",
  );
}
if (!retireRetirableLegacyVhost && reviewedLegacyVhostSha256) {
  die("--retirable-legacy-vhost-sha256 is accepted only with retirement mode");
}
if (
  (inspectRetirableLegacyVhost || retireRetirableLegacyVhost) &&
  !retirableLegacyVhost
) {
  die(`no reviewed legacy nginx vhost is registered for ${headscaleHostname}`);
}
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

const legacyVhostValidationFunction = `
validate_retirable_legacy_vhost() {
  if [ -z "$HS_RETIRABLE_LEGACY_VHOST" ] \\
      || ! sudo test -e "$HS_RETIRABLE_LEGACY_VHOST"; then
    if [ "\${HS_REQUIRE_RETIRABLE_LEGACY_VHOST:-false}" = "true" ]; then
      echo "reviewed legacy Headscale vhost is absent; refusing retirement"
      return 1
    fi
    return 0
  fi
  if sudo test -L "$HS_RETIRABLE_LEGACY_VHOST" \\
      || ! sudo test -f "$HS_RETIRABLE_LEGACY_VHOST"; then
    echo "refusing to inspect or retire a non-regular legacy Headscale vhost: $HS_RETIRABLE_LEGACY_VHOST"
    return 1
  fi
  legacy_vhost_owner=$(sudo stat -c '%U:%G' "$HS_RETIRABLE_LEGACY_VHOST")
  if [ "$legacy_vhost_owner" != "root:root" ] \\
      || sudo find "$HS_RETIRABLE_LEGACY_VHOST" -maxdepth 0 -perm /022 \\
        -print -quit | grep -q .; then
    echo "legacy Headscale vhost must be root-owned and not group/world writable"
    return 1
  fi

  legacy_vhost_source=$(sudo cat -- "$HS_RETIRABLE_LEGACY_VHOST")
  legacy_vhost_sha256=$(sudo sha256sum -- "$HS_RETIRABLE_LEGACY_VHOST" \\
    | awk '{print $1}')
  if [ -n "\${HS_REVIEWED_LEGACY_VHOST_SHA256:-}" ] \\
      && [ "$legacy_vhost_sha256" != "$HS_REVIEWED_LEGACY_VHOST_SHA256" ]; then
    echo "legacy Headscale vhost bytes changed after inspection; refusing retirement"
    return 1
  fi
  ambiguous_legacy_lines=$(printf '%s\\n' "$legacy_vhost_source" | awk '
    {
      line = $0
      sub(/^[[:space:]]+/, "", line)
      sub(/[[:space:]]+$/, "", line)
      if (line == "" || line ~ /^#/) next
      if (index(line, "#") > 0) {
        printf "line %d: hash token in active syntax\\n", NR
        next
      }
      gsub(/[$][{]http_upgrade[}]/, "$http_upgrade", line)
      gsub(/[$][{]connection_upgrade[}]/, "$connection_upgrade", line)
      semicolons = gsub(/;/, ";", line)
      opens = gsub(/[{]/, "{", line)
      closes = gsub(/[}]/, "}", line)
      if (semicolons > 1) {
        printf "line %d: multiple semicolon-terminated directives\\n", NR
      } else if (semicolons == 1 && (line !~ /;$/ || opens > 0 || closes > 0)) {
        printf "line %d: mixed block and directive syntax\\n", NR
      } else if (opens > 1 || closes > 1 || (opens > 0 && closes > 0)) {
        printf "line %d: multiple block boundaries\\n", NR
      } else if (opens == 1 && line !~ /[{]$/) {
        printf "line %d: content follows an opening block boundary\\n", NR
      } else if (closes == 1 && line != "}") {
        printf "line %d: content shares a closing block boundary\\n", NR
      }
    }
  ')
  if [ -n "$ambiguous_legacy_lines" ]; then
    echo "legacy Headscale vhost uses unsupported dense directive syntax:"
    printf '%s\\n' "$ambiguous_legacy_lines"
    return 1
  fi
  legacy_vhost_directives=$(printf '%s\\n' "$legacy_vhost_source" | awk '
    {
      line = $0
      sub(/^[[:space:]]+/, "", line)
      if (line == "" || line ~ /^#/ || line ~ /^[{}]/) next
      split(line, fields, /[[:space:]]+/)
      directive = fields[1]
      sub(/;.*$/, "", directive)
      if (directive ~ /^[[:alpha:]_][[:alnum:]_]*$/) print directive
    }
  ')
  legacy_upgrade_map_shape=$(printf '%s\\n' "$legacy_vhost_source" | awk '
    function normalize_map_variable(token, quote, name) {
      quote = substr(token, 1, 1)
      if (quote == sprintf("%c", 39) || quote == sprintf("%c", 34)) {
        if (length(token) < 2 || substr(token, length(token), 1) != quote) return ""
        token = substr(token, 2, length(token) - 2)
      }
      if (token ~ /^[$][[:alpha:]_][[:alnum:]_]*$/) return token
      if (token ~ /^[$][{][[:alpha:]_][[:alnum:]_]*[}]$/) {
        name = token
        sub(/^[$][{]/, "", name)
        sub(/[}]$/, "", name)
        return "$" name
      }
      return ""
    }
    function is_exact_map_source(token) {
      return normalize_map_variable(token) == "$http_upgrade"
    }
    function inspect_map_header(normalized, body, fields, count, has_open, output) {
      body = normalized
      sub(/^map[[:space:]]+/, "", body)
      has_open = body ~ /[{]$/
      if (has_open) sub(/[[:space:]]*[{]$/, "", body)
      count = split(body, fields, /[[:space:]]+/)
      output = count >= 2 ? normalize_map_variable(fields[2]) : ""
      if (count != 2 \
          || !is_exact_map_source(fields[1]) \
          || output == "") return 0
      upgrade_map_output_variable = output
      if (has_open) {
        blocks += 1
        in_upgrade_map = 1
      } else {
        awaiting_upgrade_map_open = 1
      }
      return 1
    }
    {
      line = $0
      sub(/^[[:space:]]+/, "", line)
      sub(/[[:space:]]+$/, "", line)
      if (line == "" || line ~ /^#/) next
      normalized = line
      gsub(/[[:space:]]+/, " ", normalized)
      if (awaiting_upgrade_map_open) {
        if (normalized == "{") {
          blocks += 1
          in_upgrade_map = 1
        } else {
          unexpected += 1
        }
        awaiting_upgrade_map_open = 0
        next
      }
      if (in_upgrade_map) {
        if (normalized == "default upgrade;") {
          defaults += 1
        } else if (normalized == "\\047\\047 close;" \
            || normalized == "\\042\\042 close;") {
          closes += 1
        } else if (normalized == "}") {
          endings += 1
          in_upgrade_map = 0
        } else {
          unexpected += 1
        }
        next
      }
      if (normalized ~ /^map[[:space:]]/) {
        if (!inspect_map_header(normalized)) {
          unexpected += 1
        }
      } else if (normalized ~ /^default[[:space:]]/) {
        unexpected += 1
      }
    }
    END {
      if (in_upgrade_map) unexpected += 1
      if (awaiting_upgrade_map_open) unexpected += 1
      printf "%d %d %d %d %d %s\\n", blocks + 0, defaults + 0, closes + 0, endings + 0, unexpected + 0, upgrade_map_output_variable
    }
  ')
  legacy_upgrade_map_output_variable=
  read -r legacy_upgrade_map_blocks legacy_upgrade_map_defaults \\
    legacy_upgrade_map_closes legacy_upgrade_map_endings \\
    legacy_upgrade_map_unexpected legacy_upgrade_map_output_variable \\
    <<<"$legacy_upgrade_map_shape"
  legacy_has_upgrade_map=false
  if [ "$legacy_upgrade_map_blocks" -ne 0 ] \\
      || [ "$legacy_upgrade_map_defaults" -ne 0 ] \\
      || [ "$legacy_upgrade_map_closes" -ne 0 ] \\
      || [ "$legacy_upgrade_map_endings" -ne 0 ] \\
      || [ "$legacy_upgrade_map_unexpected" -ne 0 ]; then
    if [ "$legacy_upgrade_map_blocks" -ne 1 ] \\
        || [ "$legacy_upgrade_map_defaults" -ne 1 ] \\
        || [ "$legacy_upgrade_map_closes" -ne 1 ] \\
        || [ "$legacy_upgrade_map_endings" -ne 1 ] \\
        || [ "$legacy_upgrade_map_unexpected" -ne 0 ] \\
        || [ -z "$legacy_upgrade_map_output_variable" ]; then
      echo "legacy Headscale vhost has an unexpected upgrade map shape: blocks=$legacy_upgrade_map_blocks defaults=$legacy_upgrade_map_defaults empty-close=$legacy_upgrade_map_closes endings=$legacy_upgrade_map_endings unexpected=$legacy_upgrade_map_unexpected"
      legacy_upgrade_map_header_profile=$(printf '%s\\n' "$legacy_vhost_source" | awk '
        function token_form(token, expected, quote, prefix) {
          quote = substr(token, 1, 1)
          prefix = ""
          if (quote == sprintf("%c", 39) || quote == sprintf("%c", 34)) {
            if (length(token) < 2 || substr(token, length(token), 1) != quote) {
              return "mismatched-quote"
            }
            token = substr(token, 2, length(token) - 2)
            prefix = "quoted-"
          }
          if (token == expected) return prefix "exact"
          if (token == "$" "{" substr(expected, 2) "}") return prefix "braced-exact"
          if (token ~ /^[$][[:alpha:]_][[:alnum:]_]*$/ \
              || token ~ /^[$][{][[:alpha:]_][[:alnum:]_]*[}]$/) {
            return prefix "other-variable"
          }
          return prefix "other"
        }
        function inspect_header(normalized, body, fields, count, has_open) {
          candidates += 1
          body = normalized
          sub(/^map[[:space:]]+/, "", body)
          has_open = body ~ /[{]$/
          if (has_open) sub(/[[:space:]]*[{]$/, "", body)
          count = split(body, fields, /[[:space:]]+/)
          if (candidates == 1) {
            field_count = count
            source_form = count >= 1 ? token_form(fields[1], "$http_upgrade") : "missing"
            target_form = count >= 2 ? token_form(fields[2], "$connection_upgrade") : "missing"
            extra_fields = count > 2 ? "yes" : "no"
            brace_form = has_open ? "same-line" : "absent"
            awaiting_brace_profile = !has_open
          }
        }
        {
          line = $0
          sub(/^[[:space:]]+/, "", line)
          sub(/[[:space:]]+$/, "", line)
          if (line == "" || line ~ /^#/) next
          normalized = line
          gsub(/[[:space:]]+/, " ", normalized)
          if (awaiting_brace_profile) {
            brace_form = normalized == "{" ? "following-line" : "absent-or-intervening"
            awaiting_brace_profile = 0
          }
          if (normalized ~ /^map[[:space:]]/) inspect_header(normalized)
        }
        END {
          if (candidates == 1) {
            printf "candidates=1 fields=%d source-form=%s target-form=%s extra-fields=%s brace=%s\\n", \
              field_count, source_form, target_form, extra_fields, brace_form
          } else {
            printf "candidates=%d\\n", candidates + 0
          }
        }
      ')
      echo "legacy Headscale upgrade map header profile: $legacy_upgrade_map_header_profile"
      return 1
    fi
    legacy_has_upgrade_map=true
  fi
  unexpected_legacy_directives=$(printf '%s\\n' "$legacy_vhost_directives" \\
    | awk '$0 !~ /^(map|default|server|listen|server_name|location|root|default_type|try_files|return|ssl_certificate|ssl_certificate_key|proxy_pass|proxy_http_version|proxy_set_header|proxy_buffering|proxy_read_timeout|proxy_send_timeout)$/ { print }')
  if [ "\${HS_ENFORCE_LEGACY_VHOST_DIRECTIVE_ALLOWLIST:-false}" = "true" ] \\
      && [ -n "$unexpected_legacy_directives" ]; then
    echo "legacy Headscale vhost contains directives outside the reviewed retirement allowlist:"
    printf '%s\\n' "$unexpected_legacy_directives"
    return 1
  fi
  legacy_server_block_count=$(printf '%s\\n' "$legacy_vhost_source" \\
    | awk '/^[[:space:]]*server[[:space:]]*\\{/ { count += 1 } END { print count + 0 }')
  legacy_server_names=$(printf '%s\\n' "$legacy_vhost_source" | awk '
    function inspect_names(text, fields, count, i, name) {
      count = split(text, fields, /[[:space:]]+/)
      for (i = 1; i <= count; i += 1) {
        name = fields[i]
        if (name == "") continue
        if (name ~ /;$/) collecting = 0
        sub(/;$/, "", name)
        gsub(/^"|"$/, "", name)
        if (name != "") print name
      }
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
  legacy_server_name_count=$(printf '%s\\n' "$legacy_server_names" \\
    | awk 'NF { count += 1 } END { print count + 0 }')
  unexpected_legacy_server_names=$(printf '%s\\n' "$legacy_server_names" \\
    | awk -v expected="$HS_LEGACY_HOST" 'NF && $0 != expected { print }')
  if [ "$legacy_server_block_count" -ne 2 ] \\
      || [ "$legacy_server_name_count" -ne 2 ] \\
      || [ -n "$unexpected_legacy_server_names" ]; then
    echo "legacy Headscale vhost does not contain exactly two expected legacy-only server blocks"
    return 1
  fi

  loaded_nginx_config=$(sudo nginx -T 2>&1)
  loaded_legacy_owners=$(printf '%s\\n' "$loaded_nginx_config" | awk \\
    -v target="$HS_RETIRABLE_LEGACY_VHOST" \\
    -v canonical="$HS_HOST" \\
    -v legacy="$HS_LEGACY_HOST" '
    function inspect_names(text, fields, count, i, name) {
      count = split(text, fields, /[[:space:]]+/)
      for (i = 1; i <= count; i += 1) {
        name = fields[i]
        if (name == "") continue
        if (name ~ /;$/) collecting = 0
        sub(/;$/, "", name)
        gsub(/^"|"$/, "", name)
        if (config_file == target && (name == canonical || name == legacy)) {
          print name
        }
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
  loaded_legacy_count=$(printf '%s\\n' "$loaded_legacy_owners" \\
    | awk -v host="$HS_LEGACY_HOST" '$0 == host { count += 1 } END { print count + 0 }')
  loaded_canonical_count=$(printf '%s\\n' "$loaded_legacy_owners" \\
    | awk -v host="$HS_HOST" '$0 == host { count += 1 } END { print count + 0 }')
  if [ "$loaded_legacy_count" -ne 2 ] || [ "$loaded_canonical_count" -ne 0 ]; then
    echo "legacy Headscale vhost ownership no longer matches the reviewed two-listener contract"
    return 1
  fi
  legacy_upgrade_map_external_reference_profile=$(printf '%s\\n' "$loaded_nginx_config" \\
    | awk -v target="$HS_RETIRABLE_LEGACY_VHOST" \\
        -v map_output="$legacy_upgrade_map_output_variable" '
      BEGIN {
        map_output_name = substr(map_output, 2)
        plain_output_pattern = "[$]" map_output_name "([^[:alnum:]_]|$)"
        braced_output_pattern = "[$][{]" map_output_name "[}]"
      }
      /^# configuration file / {
        config_file = $0
        sub(/^# configuration file /, "", config_file)
        sub(/:$/, "", config_file)
        next
      }
      map_output != "" && config_file != target \\
          && ($0 ~ plain_output_pattern || $0 ~ braced_output_pattern) {
        references_by_path[config_file] += 1
      }
      END {
        for (path in references_by_path) {
          printf "%s\\t%d\\n", path, references_by_path[path]
        }
      }
    ' | sort)
  legacy_upgrade_map_external_references=$(printf '%s\\n' \\
    "$legacy_upgrade_map_external_reference_profile" \\
    | awk -F '\\t' '{ count += $2 } END { print count + 0 }')
  legacy_upgrade_map_managed_references=$(printf '%s\\n' \\
    "$legacy_upgrade_map_external_reference_profile" \\
    | awk -F '\\t' -v managed="\${HS_VHOST:-}" \\
        '$1 == managed { count += $2 } END { print count + 0 }')
  legacy_upgrade_map_external_path_count=$(printf '%s\\n' \\
    "$legacy_upgrade_map_external_reference_profile" \\
    | awk -F '\\t' 'NF == 2 { count += 1 } END { print count + 0 }')
  # The managed vhost is backed up and replaced before legacy removal, then
  # this validator runs again. No other loaded owner or reference count is safe.
  legacy_upgrade_map_has_reviewed_managed_overlap=false
  if [ "$legacy_has_upgrade_map" = "true" ] \\
      && [ "$legacy_upgrade_map_external_references" -eq 2 ] \\
      && [ "$legacy_upgrade_map_managed_references" -eq 2 ] \\
      && [ "$legacy_upgrade_map_external_path_count" -eq 1 ]; then
    legacy_upgrade_map_has_reviewed_managed_overlap=true
  fi
  if [ "$legacy_has_upgrade_map" = "true" ] \\
      && [ "$legacy_upgrade_map_external_references" -ne 0 ] \\
      && [ "$legacy_upgrade_map_has_reviewed_managed_overlap" != "true" ]; then
    echo "legacy Headscale upgrade-map output is referenced outside the reviewed file (paths and counts only):"
    printf '%s\\n' "$legacy_upgrade_map_external_reference_profile" \\
      | awk -F '\\t' '{ printf "path=%s references=%d\\n", $1, $2 }'
    return 1
  fi
}
`;

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
HS_RETIRABLE_LEGACY_VHOST=${shellQuote(retirableLegacyVhost ?? "")}
HS_RETIRE_REVIEWED_LEGACY_VHOST=${shellQuote(
      retireRetirableLegacyVhost ? "true" : "false",
    )}
HS_REQUIRE_RETIRABLE_LEGACY_VHOST=$HS_RETIRE_REVIEWED_LEGACY_VHOST
HS_ENFORCE_LEGACY_VHOST_DIRECTIVE_ALLOWLIST=$HS_RETIRE_REVIEWED_LEGACY_VHOST
HS_REVIEWED_LEGACY_VHOST_SHA256=${shellQuote(reviewedLegacyVhostSha256 ?? "")}
CERTBOT_EMAIL=${shellQuote(certbotEmail)}
HS_VHOST=/etc/nginx/conf.d/headscale.conf
HS_ACME_VHOST=/etc/nginx/conf.d/00-headscale-acme.conf
HS_RENEW_HOOK=/etc/letsencrypt/renewal-hooks/deploy/eliza-headscale-nginx-reload
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

${legacyVhostValidationFunction}
validate_retirable_legacy_vhost

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
HS_RETIRABLE_LEGACY_VHOST_BACKUP=""
HS_RETIRABLE_LEGACY_VHOST_EXISTED=false
HS_RETIRABLE_LEGACY_VHOST_MODE=""
if sudo test -f "$HS_VHOST"; then
  sudo cp "$HS_VHOST" "$HS_VHOST_BACKUP"
  HS_VHOST_EXISTED=true
fi
if [ "$HS_RETIRE_REVIEWED_LEGACY_VHOST" = "true" ] \\
    && sudo test -f "$HS_RETIRABLE_LEGACY_VHOST"; then
  HS_RETIRABLE_LEGACY_VHOST_BACKUP=$(mktemp)
  HS_RETIRABLE_LEGACY_VHOST_MODE=$(sudo stat -c '%a' \\
    "$HS_RETIRABLE_LEGACY_VHOST")
  sudo cp -- "$HS_RETIRABLE_LEGACY_VHOST" \\
    "$HS_RETIRABLE_LEGACY_VHOST_BACKUP"
  HS_RETIRABLE_LEGACY_VHOST_EXISTED=true
fi

rollback_headscale_vhosts() {
  trap - EXIT
  if [ "$HS_VHOST_EXISTED" = "true" ]; then
    sudo cp "$HS_VHOST_BACKUP" "$HS_VHOST"
  else
    sudo rm -f "$HS_VHOST"
  fi
  if [ "$HS_RETIRABLE_LEGACY_VHOST_EXISTED" = "true" ]; then
    sudo install -o root -g root -m "$HS_RETIRABLE_LEGACY_VHOST_MODE" \\
      "$HS_RETIRABLE_LEGACY_VHOST_BACKUP" "$HS_RETIRABLE_LEGACY_VHOST"
  fi
  if sudo nginx -t; then
    sudo systemctl reload nginx
  else
    echo "rollback restored the previous Headscale vhost bytes, but nginx validation failed"
  fi
  rm -f "$HS_VHOST_BACKUP" "$HS_VHOST_STAGE"
  if [ -n "$HS_RETIRABLE_LEGACY_VHOST_BACKUP" ]; then
    rm -f "$HS_RETIRABLE_LEGACY_VHOST_BACKUP"
  fi
}

commit_headscale_vhosts() {
  # Disable rollback only after the complete remote convergence has passed.
  # Any failure before this call must restore both reviewed nginx files.
  trap - EXIT
  rm -f "$HS_VHOST_BACKUP" "$HS_VHOST_STAGE"
  if [ -n "$HS_RETIRABLE_LEGACY_VHOST_BACKUP" ]; then
    rm -f "$HS_RETIRABLE_LEGACY_VHOST_BACKUP"
  fi
  if [ "$HS_RETIRABLE_LEGACY_VHOST_EXISTED" = "true" ]; then
    echo "Retired validated legacy Headscale vhost $HS_RETIRABLE_LEGACY_VHOST"
  fi
}
trap rollback_headscale_vhosts EXIT

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
if [ "$HS_RETIRABLE_LEGACY_VHOST_EXISTED" = "true" ]; then
  validate_retirable_legacy_vhost
  sudo rm -f -- "$HS_RETIRABLE_LEGACY_VHOST"
fi
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

# Certbot's webroot renewal updates the certificate files in place. Install a
# deploy hook on every arm, including no-op certificate runs, so nginx adopts
# only a leaf that still covers both migration-overlap names. The hook is
# root-owned and validates both the certificate and nginx before reloading.
HS_RENEW_HOOK_STAGE=$(mktemp)
tee "$HS_RENEW_HOOK_STAGE" >/dev/null <<'HOOK'
#!/usr/bin/env bash
set -euo pipefail

EXPECTED_LINEAGE=${shellQuote(`/etc/letsencrypt/live/${headscaleHostname}`)}
CANONICAL_HOST=${shellQuote(headscaleHostname)}
LEGACY_HOST=${shellQuote(legacyHeadscaleHostname)}

if [ "\${RENEWED_LINEAGE:-}" != "$EXPECTED_LINEAGE" ]; then
  exit 0
fi

leaf_has_exact_san() {
  test -s "$EXPECTED_LINEAGE/fullchain.pem" \\
    && openssl x509 -in "$EXPECTED_LINEAGE/fullchain.pem" -noout -ext subjectAltName 2>/dev/null \\
      | tr ',' '\\n' \\
      | sed -n 's/^[[:space:]]*DNS://p' \\
      | grep -Fx -- "$1" >/dev/null
}

if ! leaf_has_exact_san "$CANONICAL_HOST" \\
    || ! leaf_has_exact_san "$LEGACY_HOST"; then
  echo "renewed Headscale certificate does not cover both required hostnames" >&2
  exit 1
fi

nginx -t
systemctl reload nginx
HOOK
sudo install -d -o root -g root -m 0755 "$(dirname "$HS_RENEW_HOOK")"
sudo install -o root -g root -m 0755 "$HS_RENEW_HOOK_STAGE" "$HS_RENEW_HOOK"
rm -f "$HS_RENEW_HOOK_STAGE"

# Renewal is part of the converged contract, not an advisory. Ensure certbot's
# systemd schedule exists, is enabled, and is running before the arm succeeds.
sudo systemctl enable --now certbot.timer
sudo systemctl is-enabled --quiet certbot.timer
sudo systemctl is-active --quiet certbot.timer
echo "certbot.timer active (auto-renewal wired)"

# Keep the rollback transaction active through the public edge proof. Local
# certificate files and nginx ownership are necessary but not sufficient when
# another listener or stale SNI route can still win externally.
expected_public_fingerprint=""
for public_host in "$HS_HOST" "$HS_LEGACY_HOST"; do
  public_healthy=false
  for _ in $(seq 1 30); do
    if curl --fail --silent --show-error --max-time 10 \\
        "https://$public_host/health" >/dev/null; then
      public_healthy=true
      break
    fi
    sleep 5
  done
  if [ "$public_healthy" != "true" ]; then
    echo "public Headscale health did not become ready at https://$public_host"
    exit 1
  fi

  public_leaf=$(openssl s_client \\
    -connect "$public_host:443" \\
    -servername "$public_host" \\
    -verify_hostname "$public_host" \\
    -verify_return_error \\
    -showcerts </dev/null 2>/dev/null \\
    | openssl x509 -outform PEM)
  for required_host in "$HS_HOST" "$HS_LEGACY_HOST"; do
    if ! printf '%s\\n' "$public_leaf" \\
      | openssl x509 -noout -ext subjectAltName \\
      | tr ',' '\\n' \\
      | sed -n 's/^[[:space:]]*DNS://p' \\
      | grep -Fx -- "$required_host" >/dev/null; then
      echo "$public_host did not serve a leaf with exact SAN $required_host"
      exit 1
    fi
  done
  public_fingerprint=$(printf '%s\\n' "$public_leaf" \\
    | openssl x509 -outform DER \\
    | openssl dgst -sha256 -r \\
    | awk '{print $1}')
  if [ -z "$expected_public_fingerprint" ]; then
    expected_public_fingerprint="$public_fingerprint"
  elif [ "$public_fingerprint" != "$expected_public_fingerprint" ]; then
    echo "canonical and legacy Headscale SNI served different certificate leaves"
    exit 1
  fi
done
echo "public Headscale overlap is healthy on one exact dual-SAN leaf"
`;

// ── CP self-enrollment as a tailscale node (cp-<env>-router) ─────────────────
// The CP enrolls ITSELF against its local headscale as cp-<env>-router with
// tag:eliza-cp (owned by the 'tunnel' user in acl.hujson; split from the
// dual-worn tag:eliza-proxy in #22945). This is what lets
// the daemon on the CP reach agent tag:agent 100.64.x IPs. Previously a manual
// `tailscale up` per CP (the DR gap). Idempotent: skips if a node with this
// hostname is already enrolled. headscale v0.28's `preauthkeys create -u` takes
// a numeric USER ID, not a username, so we resolve tunnel→id from users list.
const cpRouterSteps = skipCpRouter
  ? `echo "skip-cp-router set: leaving CP tailscale enrollment untouched"`
  : `
echo "--- CP self-enrollment: ${cpRouterHostname} (tag:eliza-cp) ---"
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

  # Short-lived, single-use, pre-tagged preauth key. Tagged tag:eliza-cp so
  # the node lands tagged at join (ownership enforced by acl.hujson tagOwners).
  PREAUTH_KEY=$(sudo headscale preauthkeys create -u "$TUNNEL_UID" \\
    --tags tag:eliza-cp --expiration 1h -o json 2>/dev/null | jq -r '.key')
  [ -n "$PREAUTH_KEY" ] || { echo "failed to mint preauth key for cp-router"; exit 1; }

  # This branch already proved the expected router is absent and minted a
  # fresh, single-use key. Force reauthentication so a daemon still signed in
  # to the legacy login server can move to the canonical Headscale origin.
  sudo tailscale up \\
    --force-reauth \\
    --login-server="$LOGIN_SERVER" \\
    --authkey="$PREAUTH_KEY" \\
    --hostname="$CP_ROUTER_HOST" \\
    --advertise-tags=tag:eliza-cp \\
    --accept-routes
  echo "$CP_ROUTER_HOST enrolled"
fi

sudo tailscale status 2>/dev/null | grep -F "$CP_ROUTER_HOST" \\
  || echo "WARN: $CP_ROUTER_HOST not visible in tailscale status yet"
`;

const legacyVhostInspectionRemote = `
set -euo pipefail
HS_HOST=${shellQuote(headscaleHostname)}
HS_LEGACY_HOST=${shellQuote(legacyHeadscaleHostname)}
HS_RETIRABLE_LEGACY_VHOST=${shellQuote(retirableLegacyVhost ?? "")}
HS_REQUIRE_RETIRABLE_LEGACY_VHOST=true
HS_ENFORCE_LEGACY_VHOST_DIRECTIVE_ALLOWLIST=false
HS_REVIEWED_LEGACY_VHOST_SHA256=""
HS_VHOST=/etc/nginx/conf.d/headscale.conf

if [ -z "$HS_RETIRABLE_LEGACY_VHOST" ] \\
    || ! sudo test -e "$HS_RETIRABLE_LEGACY_VHOST"; then
  echo "reviewed legacy Headscale vhost is not present"
  exit 1
fi

${legacyVhostValidationFunction}
validate_retirable_legacy_vhost
sudo stat -c 'type=%F owner=%U group=%G mode=%a bytes=%s path=%n' \\
  "$HS_RETIRABLE_LEGACY_VHOST"
echo "reviewed-sha256=$legacy_vhost_sha256"
echo "--- reviewed nginx directive-name inventory (values withheld) ---"
printf '%s\\n' "$legacy_vhost_directives" | sort | uniq -c
if [ "$legacy_has_upgrade_map" = "true" ]; then
  echo "reviewed-upgrade-map=headscale-websocket-v1 managed-references=$legacy_upgrade_map_managed_references unmanaged-references=$((legacy_upgrade_map_external_references - legacy_upgrade_map_managed_references))"
else
  echo "reviewed-upgrade-map=absent managed-references=0 unmanaged-references=0"
fi
echo "reviewed-shape=server-blocks:$legacy_server_block_count server-names:$legacy_server_name_count exact-host:$HS_LEGACY_HOST"
echo "Legacy Headscale vhost passed the read-only retirement preflight"
`;

const convergeRemote = `
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
commit_headscale_vhosts
`;

const remote = inspectRetirableLegacyVhost
  ? legacyVhostInspectionRemote
  : convergeRemote;

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

if (inspectRetirableLegacyVhost) {
  console.log("\nReviewed legacy Headscale vhost inspection passed.");
} else {
  console.log(
    "\nHeadscale armed. Next: set matching Worker secrets, then run one provision E2E.",
  );
}
