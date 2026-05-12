import type { IAgentRuntime } from '@elizaos/core';
import { z } from 'zod';

/**
 * Local-CLI tunnel config. The cloud-backed (headscale) flavor lives in
 * `@elizaos/plugin-elizacloud`; this package only configures the local
 * `tailscale` CLI.
 *
 * `TUNNEL_*` env vars are the canonical names. `TAILSCALE_*` are accepted
 * as aliases for one release window so existing `.env` files keep working.
 */
export const tunnelEnvSchema = z.object({
  TUNNEL_TAGS: z
    .union([z.string(), z.array(z.string())])
    .optional()
    .transform((value) => {
      if (Array.isArray(value)) return value.filter((tag) => tag.length > 0);
      if (typeof value === 'string' && value.length > 0)
        return value
          .split(',')
          .map((tag) => tag.trim())
          .filter((tag) => tag.length > 0);
      return ['tag:eliza-tunnel'];
    })
    .default(['tag:eliza-tunnel']),
  TUNNEL_FUNNEL: z
    .union([z.string(), z.boolean()])
    .optional()
    .transform((value) => value === true || value === 'true' || value === '1')
    .default(false),
  TUNNEL_DEFAULT_PORT: z
    .union([z.string(), z.number()])
    .optional()
    .transform((value) => {
      if (value === undefined || value === '') return 3000;
      const num = typeof value === 'string' ? Number.parseInt(value, 10) : value;
      if (Number.isNaN(num) || num <= 0 || num > 65535) return 3000;
      return num;
    })
    .default(3000),
});

export type TunnelConfig = z.infer<typeof tunnelEnvSchema>;

function readSetting(runtime: IAgentRuntime, key: string): string | undefined {
  const value = runtime.getSetting(key);
  if (value === null || value === undefined) return undefined;
  return String(value);
}

/**
 * Read `TUNNEL_<KEY>` first, then fall back to the legacy `TAILSCALE_<KEY>`.
 */
function readWithLegacy(
  runtime: IAgentRuntime,
  newKey: string,
  legacyKey: string
): string | undefined {
  return (
    readSetting(runtime, newKey) ??
    readSetting(runtime, legacyKey) ??
    process.env[newKey] ??
    process.env[legacyKey]
  );
}

export async function validateTunnelConfig(runtime: IAgentRuntime): Promise<TunnelConfig> {
  const config = {
    TUNNEL_TAGS: readWithLegacy(runtime, 'TUNNEL_TAGS', 'TAILSCALE_TAGS'),
    TUNNEL_FUNNEL: readWithLegacy(runtime, 'TUNNEL_FUNNEL', 'TAILSCALE_FUNNEL'),
    TUNNEL_DEFAULT_PORT: readWithLegacy(runtime, 'TUNNEL_DEFAULT_PORT', 'TAILSCALE_DEFAULT_PORT'),
  };
  return tunnelEnvSchema.parse(config);
}
