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
 */
export const BLOCKED_ENV_KEYS = new Set([
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "DYLD_INSERT_LIBRARIES",
  "DYLD_LIBRARY_PATH",
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
