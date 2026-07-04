/**
 * Argv helpers shared across Feed CLI commands, kept separate from `lib/args.ts`
 * (the general parser) for the fail-fast flag lookups that exit the process on
 * misuse rather than returning undefined.
 */

import { logger } from "./lib/logger.js";

/**
 * Parse a named flag value from argv.
 *
 * @example
 * parseFlagValue(['--actor', 'ailon-musk'], '--actor') // 'ailon-musk'
 * parseFlagValue(['--force'], '--actor')               // undefined
 */
export function parseFlagValue(
  args: string[],
  flag: string,
): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1) return undefined;
  const value = args[idx + 1];
  // Guard: no value supplied, or next token is another flag
  if (!value || value.startsWith("--")) {
    logger.error(
      `Flag ${flag} requires a value (e.g. ${flag} ailon-musk). Got: "${value ?? "nothing"}"`,
    );
    process.exit(1);
  }
  return value;
}
