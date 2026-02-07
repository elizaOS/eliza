import { KVClient, KVConfig } from './types';
import { RedisKV } from './adapters/redis';
import { FileKV } from './adapters/file';
import { MemoryKV } from './adapters/memory';
import { HttpKV } from './adapters/http';

export * from './types';

/**
 * Creates a new KV client instance based on configuration or environment variables.
 *
 * Backend selection logic:
 * 1. `config.backend` if specified.
 * 2. `config.url` protocol (redis://, file://, memory://, http://, https://).
 * 3. Environment variables (`KV_URL`, `REDIS_URL`).
 * 4. Defaults to `file://./computeruse-kv.json` (or memory in test environment).
 *
 * For HTTP backend:
 * - Set KV_URL=https://app.mediar.ai/api/kv
 * - Pass token in config: createClient({ token: input.ORG_TOKEN })
 * - Or set ORG_TOKEN env var as fallback
 */
export function createClient(config: KVConfig = {}): KVClient {
  // 1. Check for explicit backend selection
  if (config.backend === 'redis') return new RedisKV(config);
  if (config.backend === 'file') return new FileKV(config);
  if (config.backend === 'memory') return new MemoryKV();
  if (config.backend === 'http') return new HttpKV(config);

  // 2. Check for URL in config
  if (config.url) {
    return createClientFromUrl(config.url, config);
  }

  // 3. Check environment variables
  // Support standard Redis env vars
  const envUrl = process.env.KV_URL || process.env.REDIS_URL;
  if (envUrl) {
    return createClientFromUrl(envUrl, config);
  }

  // 4. Default fallback
  // If we are in a test environment, memory is safer/cleaner
  if (process.env.NODE_ENV === 'test') {
    return new MemoryKV();
  }

  // Otherwise, default to file-based for local persistence "it just works"
  return new FileKV(config);
}

function createClientFromUrl(url: string, config: KVConfig): KVClient {
  if (url.startsWith('redis:') || url.startsWith('rediss:')) {
    return new RedisKV({ ...config, url });
  }
  if (url.startsWith('file:')) {
    return new FileKV({ ...config, url });
  }
  if (url.startsWith('memory:')) {
    return new MemoryKV();
  }
  if (url.startsWith('http:') || url.startsWith('https:')) {
    return new HttpKV({ ...config, url });
  }

  throw new Error(`[KV] Unsupported URL scheme in: ${url}`);
}

/**
 * Default singleton instance auto-configured from environment.
 */
export const kv = createClient();
