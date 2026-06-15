import { LocalKmsAdapter, randomRootKey } from "./local-adapter.js";
import { MemoryKmsAdapter } from "./memory-adapter.js";
import { StewardKmsAdapter } from "./steward-adapter.js";
import { type KmsClient, KmsError } from "./types.js";

export type KmsBackend = "memory" | "local" | "steward";

export interface KmsFactoryOptions {
  backend?: KmsBackend;
  /** Override env source (Cloudflare Workers: pass `c.env`-merged proxy). */
  env?: NodeJS.ProcessEnv;
  steward?: {
    baseUrl: string;
    tokenProvider: () => Promise<string>;
  };
  local?: {
    rootKey: Uint8Array;
  };
}

/**
 * Resolve a KMS backend from env + explicit options.
 *
 *   ELIZA_KMS_BACKEND  memory | local | steward
 *   ELIZA_LOCAL_MODE   when "1", overrides backend default to "local"
 *
 * Defaults:
 *   - NODE_ENV=test                -> memory
 *   - ELIZA_LOCAL_MODE=1           -> local
 *   - otherwise                    -> steward (production)
 */
export function resolveKmsBackend(
  opts: KmsFactoryOptions = {},
  env: NodeJS.ProcessEnv = opts.env ?? process.env,
): KmsBackend {
  if (opts.backend) return opts.backend;
  const explicit = env.ELIZA_KMS_BACKEND;
  if (explicit === "memory" || explicit === "local" || explicit === "steward") {
    return explicit;
  }
  if (env.NODE_ENV === "test") return "memory";
  if (env.ELIZA_LOCAL_MODE === "1") return "local";
  return "steward";
}

/**
 * Decode a base64 string to a 32-byte root key. Tolerates URL-safe base64.
 * Throws KmsError if decoding fails or length is wrong.
 */
function decodeRootKey(b64: string, source: string): Uint8Array {
  // Tolerate URL-safe base64 + missing padding.
  let normalized = b64.trim().replace(/-/g, "+").replace(/_/g, "/");
  const pad = normalized.length % 4;
  if (pad === 2) normalized += "==";
  else if (pad === 3) normalized += "=";
  else if (pad === 1) {
    throw new KmsError(
      `${source} is not valid base64 (invalid length after normalization)`,
    );
  }
  let buf: Buffer;
  try {
    buf = Buffer.from(normalized, "base64");
  } catch (cause) {
    throw new KmsError(
      `${source} failed base64 decode: ${(cause as Error).message}`,
    );
  }
  if (buf.length !== 32) {
    throw new KmsError(
      `${source} must decode to 32 bytes (got ${buf.length}); generate one with ` +
        `\`openssl rand -base64 32\` or ` +
        `\`node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"\``,
    );
  }
  return new Uint8Array(buf);
}

/**
 * Resolve a root key for the `local` KMS backend from (in priority order):
 *   1. opts.local.rootKey                (explicit, e.g. tests / desktop vault)
 *   2. env.ELIZA_LOCAL_ROOT_KEY          (production / Workers secret)
 *
 * Throws when no key is available outside a test environment — silently
 * generating a random root would lose every ciphertext on next cold start.
 */
function resolveLocalRootKey(
  opts: KmsFactoryOptions,
  env: NodeJS.ProcessEnv,
): Uint8Array {
  if (opts.local?.rootKey) return opts.local.rootKey;

  const fromEnv = env.ELIZA_LOCAL_ROOT_KEY;
  if (fromEnv && fromEnv.length > 0) {
    return decodeRootKey(fromEnv, "ELIZA_LOCAL_ROOT_KEY");
  }

  if (env.NODE_ENV === "test") {
    // Tests: ephemeral key is fine (each test process is its own world).
    return randomRootKey();
  }

  throw new KmsError(
    "LocalKmsAdapter requires a persistent root key; set ELIZA_LOCAL_ROOT_KEY " +
      "(base64-encoded 32 bytes) or pass opts.local.rootKey. Generate with: " +
      "`openssl rand -base64 32`",
  );
}

export function createKmsClient(opts: KmsFactoryOptions = {}): KmsClient {
  const env = opts.env ?? process.env;
  let backend = resolveKmsBackend(opts, env);

  // Production-safety fallback: if the operator selected `steward` (or it
  // defaulted there) but did not pass steward config AND a local root key is
  // provisioned, fall back to local. This keeps SIWE signup / api-key
  // encryption working without silently degrading security posture in a
  // misconfigured deploy (the env var must be explicitly set).
  if (backend === "steward" && !opts.steward) {
    const localKey = env.ELIZA_LOCAL_ROOT_KEY;
    if (localKey && localKey.length > 0) {
      // eslint-disable-next-line no-console
      console.warn(
        "[kms] ELIZA_KMS_BACKEND=steward selected but steward.{baseUrl,tokenProvider} " +
          "not provided; ELIZA_LOCAL_ROOT_KEY is set — falling back to local backend. " +
          "Remove this fallback by setting ELIZA_KMS_BACKEND=local explicitly.",
      );
      backend = "local";
    }
  }

  switch (backend) {
    case "memory":
      return new MemoryKmsAdapter();
    case "local": {
      const rootKey = resolveLocalRootKey(opts, env);
      return new LocalKmsAdapter({ rootKey });
    }
    case "steward": {
      const cfg = opts.steward;
      if (!cfg) {
        throw new KmsError(
          "ELIZA_KMS_BACKEND=steward requires steward.{baseUrl, tokenProvider}",
        );
      }
      return new StewardKmsAdapter(cfg);
    }
  }
}

export * from "./key-namespace.js";
export * from "./types.js";
export { LocalKmsAdapter, MemoryKmsAdapter, StewardKmsAdapter };
