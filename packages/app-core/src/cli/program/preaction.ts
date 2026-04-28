import { isTruthyEnvValue } from "@elizaos/shared";
import type { Command } from "commander";
import { setVerbose } from "../../utils/globals";
import { getCommandPath, getVerboseFlag, hasHelpOrVersion } from "../argv";
import { emitCliBanner } from "../banner";
import { resolveCliName } from "../cli-name";

function setProcessTitleForCommand(actionCommand: Command) {
  let current: Command = actionCommand;
  while (current.parent?.parent) {
    current = current.parent;
  }
  const name = current.name();
  const cliName = resolveCliName();
  if (!name || name === cliName) {
    return;
  }
  process.title = `${cliName}-${name}`;
}

export function registerPreActionHooks(
  program: Command,
  programVersion: string,
) {
  program.hook("preAction", async (_thisCommand, actionCommand) => {
    setProcessTitleForCommand(actionCommand);
    const argv = process.argv;
    if (hasHelpOrVersion(argv)) {
      return;
    }
    const commandPath = getCommandPath(argv, 2);
    const hideBanner =
      isTruthyEnvValue(process.env.ELIZA_HIDE_BANNER) ||
      commandPath[0] === "update" ||
      commandPath[0] === "completion";
    if (!hideBanner) {
      emitCliBanner(programVersion);

      const { scheduleUpdateNotification } = await import(
        "../../services/update-notifier"
      );
      scheduleUpdateNotification();
    }
    const verbose = getVerboseFlag(argv, { includeDebug: true });
    setVerbose(verbose);
    if (!verbose) {
      process.env.NODE_NO_WARNINGS ??= "1";
    }
  });
}
