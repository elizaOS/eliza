import { CLI_PREFIX_RE, replaceCliName, resolveCliName } from "./cli-name";
import { normalizeProfileName } from "./profile-utils";

const PROFILE_FLAG_RE = /(?:^|\s)--profile(?:\s|=|$)/;
const DEV_FLAG_RE = /(?:^|\s)--dev(?:\s|$)/;

export function formatCliCommand(
  command: string,
  env: Record<string, string | undefined> = process.env as Record<
    string,
    string | undefined
  >,
): string {
  const cliName = resolveCliName();
  const normalizedCommand = replaceCliName(command, cliName);
  const profile = normalizeProfileName(env.ELIZA_PROFILE);
  if (!profile) {
    return normalizedCommand;
  }
  if (!CLI_PREFIX_RE.test(normalizedCommand)) {
    return normalizedCommand;
  }
  if (
    PROFILE_FLAG_RE.test(normalizedCommand) ||
    DEV_FLAG_RE.test(normalizedCommand)
  ) {
    return normalizedCommand;
  }
  return normalizedCommand.replace(
    CLI_PREFIX_RE,
    (match) => `${match} --profile ${profile}`,
  );
}
