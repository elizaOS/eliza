---
title: "Security architecture"
sidebarTitle: "Security"
description: "Security layers, hardening measures, and review notes for the Eliza codebase."
---

# Security Architecture

This document describes the security architecture and hardening measures implemented in the Eliza codebase. It is intended for developers, auditors, and contributors who want to understand the defensive layers in place.

---

## Table of Contents

1. [SSRF Protection](#ssrf-protection)
2. [Environment Variable Blocklist](#environment-variable-blocklist)
3. [SQL Injection Guards](#sql-injection-guards)
4. [Command Injection Defenses](#command-injection-defenses)
5. [Prototype Pollution Prevention](#prototype-pollution-prevention)
6. [Plugin Installation Safety](#plugin-installation-safety)
7. [Electrobun RPC Validation](#electrobun-rpc-validation)
8. [Auth & Token Model](#auth--token-model)
9. [DNS Rebinding Protection](#dns-rebinding-protection)
10. [Configuration Injection Prevention](#configuration-injection-prevention)

---

## SSRF Protection

**File:** `src/security/network-policy.ts`

All user-supplied URLs (e.g. knowledge ingestion, web fetches) are validated through a multi-layer SSRF defense:

### URL Protocol Validation
Only `http:` and `https:` protocols are permitted. This blocks `file:`, `ftp:`, `gopher:`, `data:`, and other protocol-based attacks.

### IP Address Blocklist
The `isBlockedPrivateOrLinkLocalIp()` function blocks access to:

| Range | Purpose |
|-------|---------|
| `0.0.0.0/8` | "This" network |
| `10.0.0.0/8` | RFC 1918 private |
| `127.0.0.0/8` | Loopback |
| `169.254.0.0/16` | Link-local / cloud metadata |
| `172.16.0.0/12` | RFC 1918 private |
| `192.168.0.0/16` | RFC 1918 private |
| `::` | IPv6 unspecified |
| `::1` | IPv6 loopback |
| `fc00::/7` | IPv6 unique local |
| `fe80::/10` | IPv6 link-local |
| `::ffff:` mapped | IPv4-mapped IPv6 addresses (decoded and rechecked) |

### DNS Resolution Verification
**File:** `src/runtime/custom-actions.ts` (`isBlockedUrl()`)

After hostname validation, the `isBlockedUrl()` function performs DNS resolution (via `node:dns/promises` `lookup`) and checks **every resolved IP address** against the blocklist using `isBlockedPrivateOrLinkLocalIp()` from `network-policy.ts`. This prevents DNS rebinding and split-horizon DNS attacks where a hostname resolves to a private IP.

### Hostname Blocklist
Literal hostnames like `localhost`, `metadata.google.internal`, and cloud metadata service hostnames are explicitly blocked.

### Test Coverage
See `src/security/network-policy.test.ts` for comprehensive tests including IPv4, IPv6, mapped addresses, and edge cases.

---

## Environment Variable Blocklist

**File:** `src/api/server.ts`

The `BLOCKED_ENV_KEYS` set prevents the API from writing to security-sensitive environment variables via `PUT /api/env`. Without this, an attacker with API access could:

### System Injection Vectors (blocked)
- `LD_PRELOAD`, `LD_LIBRARY_PATH` — shared library injection (Linux)
- `DYLD_INSERT_LIBRARIES`, `DYLD_LIBRARY_PATH` — dylib injection (macOS)
- `NODE_OPTIONS` — arbitrary Node.js flags (e.g. `--require` for code injection)
- `NODE_PATH` — module resolution override

### TLS/Proxy Hijack (blocked)
- `NODE_TLS_REJECT_UNAUTHORIZED` — setting to `"0"` disables **all** certificate verification, enabling MITM of API key traffic
- `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY` — redirects all traffic through attacker proxy
- `SSL_CERT_FILE`, `SSL_CERT_DIR`, `CURL_CA_BUNDLE`, `NODE_EXTRA_CA_CERTS` — trust rogue CAs

### Privilege Escalation Tokens (blocked)
- `ELIZA_API_TOKEN` — API authentication
- `ELIZA_WALLET_EXPORT_TOKEN` — wallet private key export
- `ELIZA_TERMINAL_RUN_TOKEN` — shell command execution
- `HYPERSCAPE_AUTH_TOKEN` — cloud service auth

### Sensitive Credentials (blocked)
- `EVM_PRIVATE_KEY`, `SOLANA_PRIVATE_KEY` — wallet private keys
- `GITHUB_TOKEN` — source code access
- `DATABASE_URL`, `POSTGRES_URL` — database connection strings

### System Paths (blocked)
- `PATH`, `HOME`, `SHELL` — system path manipulation

---

## SQL Injection Guards

**File:** `src/api/database.ts`

The database API enforces read-only query execution with multiple layers:

1. **Mutation keyword detection** — Blocks `INSERT`, `UPDATE`, `DELETE`, `DROP`, `ALTER`, `CREATE`, `TRUNCATE`, `REPLACE`, `ATTACH`, `DETACH`, `PRAGMA` (write-mode)
2. **Dangerous function detection** — Blocks PostgreSQL-specific functions that could escape the query sandbox:
   - **File I/O:** `pg_read_file`, `pg_write_file`, `pg_stat_file`, `pg_ls_dir`, `lo_import`, `lo_export`
   - **Sequence/state mutation:** `nextval`, `setval`
   - **Denial of service:** `pg_sleep`, `pg_sleep_for`, `pg_sleep_until`
   - **Backend control:** `pg_terminate_backend`, `pg_cancel_backend`, `pg_reload_conf`, `set_config`
   - **Advisory locks:** `pg_advisory_lock`, `pg_advisory_unlock`, and variants
3. **Read-only mode** — Queries execute in read-only mode as a defense-in-depth measure

---

## Command Injection Defenses

### Terminal Run Endpoint
**File:** `src/api/server.ts` (`/api/terminal/run`)

The shell execution endpoint applies multiple constraints:
- **Token authentication** — requires `ELIZA_TERMINAL_RUN_TOKEN`
- **Length limit** — commands are capped at a maximum character length
- **Control character rejection** — newlines, carriage returns, and other control characters are blocked to prevent command chaining
- **Rate limiting** — concurrent shell executions are bounded

### Sandbox Routes
**File:** `src/api/sandbox-routes.ts`

The `runCommand()` helper uses `execFileSync` with argument arrays, preventing shell metacharacter injection for general command execution. Note that `execSync` is also used elsewhere in the file for platform-specific operations (PowerShell commands, `osascript`, `wmctrl`/`xdotool`, audio recording, Docker). Variables used in commands are bounded integers or server-generated paths, never raw user input.

### Custom Actions
**File:** `src/runtime/custom-actions.ts`

Shell and code execution handlers are gated behind explicit configuration flags. The VM sandbox uses `vm.runInNewContext` with a restricted global scope.

---

## Prototype Pollution Prevention

**File:** `src/api/server.ts`

Object property manipulation endpoints explicitly block dangerous keys:
- `__proto__`
- `constructor`
- `prototype`

This prevents prototype pollution attacks that could modify the behavior of all JavaScript objects in the runtime.

---

## Plugin Installation Safety

**Files:** `src/services/plugin-installer.ts`, `src/services/plugin-eject.ts`, `src/services/core-eject.ts`

All `npm install` and `bun install` calls include the `--ignore-scripts` flag to prevent:
- Postinstall RCE from malicious packages
- Lifecycle script execution during dependency installation
- Supply chain attacks via compromised npm packages

---

## Electrobun RPC Validation

**File:** `apps/app/electrobun/src/native/desktop.ts`

### `shell.openExternal` Validation
URLs passed to `shell.openExternal` are validated to only allow `http:` and `https:` schemes. This prevents:
- `file:` scheme abuse (reading local files)
- `javascript:` scheme execution
- Custom protocol handler attacks

### `shell.showItemInFolder` Validation
File paths are validated to prevent path traversal and ensure they point to legitimate filesystem locations.

### Context Menu
The "Open Link in Browser" context menu option routes through the same validated `openExternal` helper, preventing bypass via right-click.

---

## Auth & Token Model

### API Token
- `ELIZA_API_TOKEN` — Required for authenticated API access when set
- Token is checked on every request in the middleware chain

### Wallet Export Token
- `ELIZA_WALLET_EXPORT_TOKEN` — Required to export private keys via `/api/wallet/export`
- Separate from the API token as an additional layer of defense
- Private keys are masked in all other API responses

### Terminal Run Token
- `ELIZA_TERMINAL_RUN_TOKEN` — Required to execute shell commands via `/api/terminal/run`
- Separate from API token to prevent accidental shell access

---

## DNS Rebinding Protection

**File:** `src/api/server.ts`

Host header validation prevents DNS rebinding attacks where an attacker's domain resolves to `127.0.0.1` and bypasses same-origin policy. The server validates the `Host` header against expected values.

---

## Configuration Injection Prevention

**File:** `src/api/server.ts`

### `$include` Directive Blocking
The `isBlockedObjectKey()` function blocks dangerous property keys including `$include` directives across **all object property manipulation endpoints** — not just config writes. This prevents including arbitrary files from the filesystem into any object, potentially leaking secrets or overriding security settings. The same guard also blocks `__proto__`, `constructor`, and `prototype` (see [Prototype Pollution Prevention](#prototype-pollution-prevention)).

### Top-Level Key Allowlist
Only known top-level configuration keys are accepted (`CONFIG_WRITE_ALLOWED_TOP_KEYS`). This prevents injection of arbitrary configuration properties.

---

## Reporting Security Issues

If you discover a security vulnerability, please report it responsibly through a **private channel** — do **not** open a public GitHub issue, as this risks 0-day disclosure. Use one of:

- **GitHub private vulnerability reporting** via the repository's Security tab
- **Direct contact** with the maintainers
