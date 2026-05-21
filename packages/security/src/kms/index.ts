import { LocalKmsAdapter, randomRootKey } from "./local-adapter.js";
import { MemoryKmsAdapter } from "./memory-adapter.js";
import { StewardKmsAdapter } from "./steward-adapter.js";
import { KmsError, type KmsClient } from "./types.js";

export type KmsBackend = "memory" | "local" | "steward";

export interface KmsFactoryOptions {
  backend?: KmsBackend;
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
  env: NodeJS.ProcessEnv = process.env,
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

export function createKmsClient(opts: KmsFactoryOptions = {}): KmsClient {
  const backend = resolveKmsBackend(opts);
  switch (backend) {
    case "memory":
      return new MemoryKmsAdapter();
    case "local": {
      const rootKey = opts.local?.rootKey ?? randomRootKey();
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

export { LocalKmsAdapter, MemoryKmsAdapter, StewardKmsAdapter };
export * from "./types.js";
export * from "./key-namespace.js";
