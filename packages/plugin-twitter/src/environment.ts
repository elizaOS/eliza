import { type IAgentRuntime, parseBooleanFromText } from '@elizaos/core';
import { ZodError, z } from 'zod';

/**
 * Schema for validating an X/Twitter Username.
 *
 * Constraints:
 * - Must be at least 1 character long
 * - Cannot exceed 15 characters
 * - Can only contain letters, numbers, and underscores
 * - Special case allows wildcard '*' as value
 *
 * @type {import("zod").StringType}
 */
const _twitterUsernameSchema = z
  .string()
  .min(1, 'An X/Twitter Username must be at least 1 character long')
  .max(15, 'An X/Twitter Username cannot exceed 15 characters')
  .refine((username) => {
    // Allow wildcard '*' as a special case
    if (username === '*') return true;

    // Twitter usernames can:
    // - Start with digits now
    // - Contain letters, numbers, underscores
    // - Must not be empty
    return /^[A-Za-z0-9_]+$/.test(username);
  }, 'An X Username can only contain letters, numbers, and underscores');

/**
 * This schema defines all required/optional environment settings,
 * including new fields like TWITTER_SPACES_ENABLE.
 */
/**
 * Schema definition for Twitter environment variables
 */
export const twitterEnvSchema = z.object({
  TWITTER_DRY_RUN: z.boolean(),
  TWITTER_USERNAME: z.string().min(1, 'X/Twitter username is required'),
  TWITTER_PASSWORD: z.string().min(1, 'X/Twitter password is required'),
  TWITTER_EMAIL: z.string().email('Valid X/Twitter email is required'),
  TWITTER_2FA_SECRET: z.string().default(undefined),
  TWITTER_RETRY_LIMIT: z.number().int(),
  TWITTER_POLL_INTERVAL: z.number().int(),
  // I guess it's possible to do the transformation with zod
  // not sure it's preferable, maybe a readability issue
  // since more people will know js/ts than zod
  /*
        z
        .string()
        .transform((val) => val.trim())
        .pipe(
            z.string()
                .transform((val) =>
                    val ? val.split(',').map((u) => u.trim()).filter(Boolean) : []
                )
                .pipe(
                    z.array(
                        z.string()
                            .min(1)
                            .max(15)
                            .regex(
                                /^[A-Za-z][A-Za-z0-9_]*[A-Za-z0-9]$|^[A-Za-z]$/,
                                'Invalid Twitter username format'
                            )
                    )
                )
                .transform((users) => users.join(','))
        )
        .optional()
        .default(''),
    */
  TWITTER_ENABLE_POST_GENERATION: z.boolean(),
  TWITTER_POST_INTERVAL_MIN: z.number().int(),
  TWITTER_POST_INTERVAL_MAX: z.number().int(),
  TWITTER_POST_IMMEDIATELY: z.boolean(),
  TWITTER_SPACES_ENABLE: z.boolean().default(false),
});

export type TwitterConfig = z.infer<typeof twitterEnvSchema>;

/**
 * Helper to parse a comma-separated list of Twitter usernames
 * (already present in your code).
 */
function parseTargetUsers(targetUsersStr?: string | null): string[] {
  if (!targetUsersStr?.trim()) {
    return [];
  }
  return targetUsersStr
    .split(',')
    .map((user) => user.trim())
    .filter(Boolean);
}

function safeParseInt(value: string | undefined | null, defaultValue: number): number {
  if (!value) return defaultValue;
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? defaultValue : Math.max(1, parsed);
}

/**
 * Validates or constructs a TwitterConfig object using zod,
 * taking values from the IAgentRuntime or process.env as needed.
 */
// This also is organized to serve as a point of documentation for the client
// most of the inputs from the framework (env/character)

// we also do a lot of typing/prompt here
// so we can do it once and only once per character
export async function validateTwitterConfig(
  runtime: IAgentRuntime,
  config: Partial<TwitterConfig> = {}
): Promise<TwitterConfig> {
  try {
    const twitterConfig = {
      TWITTER_DRY_RUN:
        parseBooleanFromText(
          runtime.getSetting('TWITTER_DRY_RUN') || process.env.TWITTER_DRY_RUN
        ) ?? false,

      TWITTER_USERNAME: runtime.getSetting('TWITTER_USERNAME') || process.env.TWITTER_USERNAME,

      TWITTER_PASSWORD: runtime.getSetting('TWITTER_PASSWORD') || process.env.TWITTER_PASSWORD,

      TWITTER_EMAIL: runtime.getSetting('TWITTER_EMAIL') || process.env.TWITTER_EMAIL,

      TWITTER_2FA_SECRET:
        runtime.getSetting('TWITTER_2FA_SECRET') || process.env.TWITTER_2FA_SECRET || '',

      // int
      TWITTER_RETRY_LIMIT: safeParseInt(
        runtime.getSetting('TWITTER_RETRY_LIMIT') || process.env.TWITTER_RETRY_LIMIT,
        5
      ),

      // int in seconds
      TWITTER_POLL_INTERVAL: safeParseInt(
        runtime.getSetting('TWITTER_POLL_INTERVAL') || process.env.TWITTER_POLL_INTERVAL,
        120 // 2m
      ),

      // bool
      TWITTER_ENABLE_POST_GENERATION:
        parseBooleanFromText(
          runtime.getSetting('TWITTER_ENABLE_POST_GENERATION') ||
            process.env.TWITTER_ENABLE_POST_GENERATION
        ) ?? true,

      // int in minutes
      TWITTER_POST_INTERVAL_MIN: safeParseInt(
        runtime.getSetting('TWITTER_POST_INTERVAL_MIN') || process.env.TWITTER_POST_INTERVAL_MIN,
        90 // 1.5 hours
      ),

      // int in minutes
      TWITTER_POST_INTERVAL_MAX: safeParseInt(
        runtime.getSetting('TWITTER_POST_INTERVAL_MAX') || process.env.TWITTER_POST_INTERVAL_MAX,
        180 // 3 hours
      ),

      // bool
      TWITTER_POST_IMMEDIATELY:
        parseBooleanFromText(
          runtime.getSetting('TWITTER_POST_IMMEDIATELY') || process.env.TWITTER_POST_IMMEDIATELY
        ) ?? false,

      TWITTER_SPACES_ENABLE:
        parseBooleanFromText(
          runtime.getSetting('TWITTER_SPACES_ENABLE') || process.env.TWITTER_SPACES_ENABLE
        ) ?? false,
      ...config,
    };

    return twitterEnvSchema.parse(twitterConfig);
  } catch (error) {
    if (error instanceof ZodError) {
      const errorMessages = error.errors
        .map((err) => `${err.path.join('.')}: ${err.message}`)
        .join('\n');
      throw new Error(`X/Twitter configuration validation failed:\n${errorMessages}`);
    }
    throw error;
  }
}
