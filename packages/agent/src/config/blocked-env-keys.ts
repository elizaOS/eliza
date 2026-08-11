/**
 * Environment variable keys that must never be written through user-editable
 * config or synced from config into process.env.
 *
 * Categories:
 * - Process-level code injection (NODE_OPTIONS, LD_PRELOAD, ...)
 * - TLS/proxy hijack (NODE_TLS_REJECT_UNAUTHORIZED, HTTP_PROXY, ...)
 * - Module/path resolution and process identity (NODE_PATH, PATH, HOME, ...)
 * - Privilege escalation and step-up tokens
 * - Wallet/steward/private trading secrets
 * - Database connection strings
 *
 * The process-level code-injection category must stay a superset of core's
 * BLOCKED_SPAWN_ENV_KEYS. That list guards a caller-supplied child environment;
 * this one guards config and API writes, which land in `process.env` and are
 * then inherited by every spawn site that does not pass an explicit env. A key
 * blocked there but not here is reachable through this path, so the two lists
 * are kept aligned and a test in blocked-env-keys.test.ts enforces it. The keys
 * are listed literally rather than spread from core: mcp-server-config.ts
 * records that the core barrel must not be captured at module-init.
 */
export const BLOCKED_ENV_KEYS = new Set([
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  // ld.so audit hook: loads an arbitrary shared object into every spawned
  // dynamically linked binary, the same code-injection primitive as LD_PRELOAD
  // above. Several spawn sites hand this process's environment straight to a
  // child (audio-redaction, sandbox-engine, workspace, shell router), so a key
  // that survives this list reaches them all.
  "LD_AUDIT",
  "DYLD_INSERT_LIBRARIES",
  "DYLD_LIBRARY_PATH",
  "DYLD_FRAMEWORK_PATH",
  // Interpreter module-path and startup hijacks. These only bite when a
  // matching interpreter is spawned, but they are the same class as
  // NODE_OPTIONS/NODE_PATH below and the spawn/MCP denylist already blocks
  // them; keeping the two lists aligned is what stops the drift.
  "PYTHONPATH",
  "PYTHONSTARTUP",
  "PYTHONHOME",
  "PERL5OPT",
  "PERL5LIB",
  "RUBYOPT",
  "RUBYLIB",
  "NODE_OPTIONS",
  "NODE_EXTRA_CA_CERTS",
  "NODE_TLS_REJECT_UNAUTHORIZED",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "NODE_PATH",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "CURL_CA_BUNDLE",
  "PATH",
  "HOME",
  "SHELL",
  "ELIZA_API_TOKEN",
  "ELIZA_WALLET_EXPORT_TOKEN",
  "ELIZA_TERMINAL_RUN_TOKEN",
  "EVM_PRIVATE_KEY",
  "SOLANA_PRIVATE_KEY",
  "STEWARD_API_KEY",
  "STEWARD_AGENT_TOKEN",
  "ELIZA_CLOUD_CLIENT_ADDRESS_KEY",
  "OPINION_PRIVATE_KEY",
  "OPINION_API_KEY",
  "GITHUB_TOKEN",
  "DATABASE_URL",
  "POSTGRES_URL",
]);
