import type { IAgentRuntime } from '@elizaos/core';
import { elizaLogger } from '@elizaos/core';
import { z } from 'zod';

export const ngrokEnvSchema = z.object({
  NGROK_AUTH_TOKEN: z.string().optional(),
  NGROK_REGION: z
    .union([z.string(), z.number()])
    .optional()
    .transform((val) => {
      if (val === undefined || val === null) {
        return 'us';
      }
      return String(val);
    })
    .default('us'),
  NGROK_SUBDOMAIN: z.string().optional(),
  NGROK_DOMAIN: z.string().optional(),
  NGROK_DEFAULT_PORT: z
    .union([z.string(), z.number()])
    .optional()
    .transform((val) => {
      if (val === undefined || val === '') {
        return 3000;
      }
      const num = typeof val === 'string' ? parseInt(val, 10) : val;
      // If port is 0 or invalid, use default
      if (Number.isNaN(num) || num <= 0 || num > 65535) {
        return 3000;
      }
      return num;
    })
    .default(3000),
});

export type NgrokConfig = z.infer<typeof ngrokEnvSchema>;

/**
 * Coerce a runtime setting (string | number | boolean | null) to a string suitable
 * for schema parsing. Null/undefined return undefined so optional schema fields work.
 */
function settingToString(value: string | number | boolean | null | undefined): string | undefined {
  if (value === null || value === undefined) return undefined;
  return String(value);
}

export async function validateNgrokConfig(runtime: IAgentRuntime): Promise<NgrokConfig> {
  try {
    elizaLogger.debug('Validating Ngrok configuration with runtime settings');
    const config = {
      NGROK_AUTH_TOKEN:
        settingToString(runtime.getSetting('NGROK_AUTH_TOKEN')) ?? process.env.NGROK_AUTH_TOKEN,
      NGROK_REGION: settingToString(runtime.getSetting('NGROK_REGION')) ?? process.env.NGROK_REGION,
      NGROK_SUBDOMAIN:
        settingToString(runtime.getSetting('NGROK_SUBDOMAIN')) ?? process.env.NGROK_SUBDOMAIN,
      NGROK_DOMAIN: settingToString(runtime.getSetting('NGROK_DOMAIN')) ?? process.env.NGROK_DOMAIN,
      NGROK_DEFAULT_PORT:
        settingToString(runtime.getSetting('NGROK_DEFAULT_PORT')) ??
        process.env.NGROK_DEFAULT_PORT ??
        process.env.NGROK_TUNNEL_PORT,
    };

    elizaLogger.debug({ config }, 'Parsing configuration with schema');
    const validated = ngrokEnvSchema.parse(config);
    elizaLogger.debug('Configuration validated successfully');
    return validated;
  } catch (error) {
    if (error instanceof z.ZodError) {
      const errorMessages = error.issues.map((e) => `${e.path.join('.')}: ${e.message}`).join('\n');
      elizaLogger.error(`Configuration validation failed: ${errorMessages}`);
      throw new Error(`Ngrok configuration validation failed:\n${errorMessages}`);
    }
    throw error;
  }
}
