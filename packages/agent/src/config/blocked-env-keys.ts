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
 * The code-injection category must remain a superset of core's
 * `BLOCKED_SPAWN_ENV_KEYS`: that list guards a caller-supplied child
 * environment, this one guards writes that land in `process.env` and are
 * inherited by every child spawned without an explicit env override.
 */
export const BLOCKED_ENV_KEYS = new Set([
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  // ld.so audit hook: loads an arbitrary shared object into every spawned
  // dynamically linked binary — same code-injection primitive as LD_PRELOAD.
  "LD_AUDIT",
  "DYLD_INSERT_LIBRARIES",
  "DYLD_LIBRARY_PATH",
  "DYLD_FRAMEWORK_PATH",
  // Interpreter hijack vars (same class as NODE_OPTIONS/NODE_PATH below):
  // attacker-controlled module paths / auto-run options for spawned
  // python/perl/ruby processes. All are on sudo's default env_delete list.
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
