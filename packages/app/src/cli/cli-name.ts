/**
 * Resolves the CLI's display name (`APP_CLI_NAME`, default "eliza") and rewrites
 * command strings so generated help and examples show the active binary name.
 * `replaceCliName` swaps a leading `eliza`/`elizaos` token — with an optional
 * `bun`/`npm`/`bunx`/`npx` runner prefix matched by `CLI_PREFIX_RE` — for the
 * resolved name, leaving unrelated commands untouched.
 */
/** CLI name — reads from APP_CLI_NAME env var, defaults to "eliza". */
const CLI_NAME = process.env.APP_CLI_NAME?.trim() || "eliza";

/** Matches a CLI command with optional package-runner prefix. */
export const CLI_PREFIX_RE =
  /^(?:((?:bun|npm|bunx|npx)\s+))?(?:eliza|elizaos)\b/;

export function resolveCliName(): string {
  return CLI_NAME;
}

export function replaceCliName(
  command: string,
  cliName = resolveCliName(),
): string {
  if (!command.trim() || !CLI_PREFIX_RE.test(command)) {
    return command;
  }
  return command.replace(
    CLI_PREFIX_RE,
    (_match, runner: string | undefined) => {
      return `${runner ?? ""}${cliName}`;
    },
  );
}
