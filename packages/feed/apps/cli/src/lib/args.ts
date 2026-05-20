/**
 * @fileoverview Command-line argument parsing utilities
 *
 * Provides functions for parsing CLI arguments into structured formats,
 * extracting flags, options, and positional arguments.
 *
 * @module cli/lib/args
 */

/**
 * Parsed command-line arguments structure.
 */
export interface ParsedArgs {
  command: string;
  positional: string[];
  flags: Record<string, boolean>;
  options: Record<string, string>;
}

/**
 * Parses command-line arguments into a structured format.
 *
 * Supports:
 * - Long options: `--flag`, `--option=value`, `--option value`
 * - Short options: `-f`, `-o value`
 * - Positional arguments
 * - Commands (first non-flag argument)
 *
 * @param args - Array of command-line arguments (typically `process.argv.slice(2)`)
 * @returns Parsed arguments with command, positional args, flags, and options
 *
 * @example
 * ```typescript
 * parseArgs(['grant', 'alice', '--verbose', '--count=5'])
 * // Returns: { command: 'grant', positional: ['alice'], flags: { verbose: true }, options: { count: '5' } }
 * ```
 */
export function parseArgs(args: string[]): ParsedArgs {
  const result: ParsedArgs = {
    command: '',
    positional: [],
    flags: {},
    options: {},
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg) continue;

    if (arg.startsWith('--')) {
      const [key, value] = arg.slice(2).split('=');
      if (key) {
        if (value !== undefined) {
          result.options[key] = value;
        } else {
          const nextArg = args[i + 1];
          if (nextArg && !nextArg.startsWith('-')) {
            result.options[key] = nextArg;
            i++;
          } else {
            result.flags[key] = true;
          }
        }
      }
    } else if (arg.startsWith('-') && arg.length === 2) {
      const key = arg.slice(1);
      const nextArg = args[i + 1];
      if (nextArg && !nextArg.startsWith('-')) {
        result.options[key] = nextArg;
        i++;
      } else {
        result.flags[key] = true;
      }
    } else if (!result.command) {
      result.command = arg;
    } else {
      result.positional.push(arg);
    }
  }

  return result;
}

/**
 * Checks if the help flag is present in parsed arguments.
 *
 * @param args - Parsed arguments to check
 * @returns `true` if `--help`, `-h`, or `help` command is present
 */
export function wantsHelp(args: ParsedArgs): boolean {
  return (
    args.flags['help'] === true ||
    args.flags['h'] === true ||
    args.command === 'help'
  );
}

/**
 * Gets an option value from parsed arguments, checking both long and short forms.
 *
 * @param args - Parsed arguments to search
 * @param long - Long option name (e.g., `'count'` for `--count`)
 * @param short - Optional short option name (e.g., `'c'` for `-c`)
 * @returns Option value if found, `undefined` otherwise
 *
 * @example
 * ```typescript
 * const args = parseArgs(['--count=5']);
 * getOption(args, 'count', 'c'); // Returns: '5'
 * ```
 */
export function getOption(
  args: ParsedArgs,
  long: string,
  short?: string
): string | undefined {
  return args.options[long] ?? (short ? args.options[short] : undefined);
}

/**
 * Gets a boolean flag value from parsed arguments, checking both long and short forms.
 *
 * @param args - Parsed arguments to search
 * @param long - Long flag name (e.g., `'verbose'` for `--verbose`)
 * @param short - Optional short flag name (e.g., `'v'` for `-v`)
 * @returns `true` if flag is present, `false` otherwise
 *
 * @example
 * ```typescript
 * const args = parseArgs(['--verbose']);
 * getFlag(args, 'verbose', 'v'); // Returns: true
 * ```
 */
export function getFlag(
  args: ParsedArgs,
  long: string,
  short?: string
): boolean {
  return (
    args.flags[long] === true || (short ? args.flags[short] === true : false)
  );
}
