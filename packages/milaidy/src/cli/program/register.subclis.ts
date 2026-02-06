import type { Command } from "commander";
import { isTruthyEnvValue } from "../../globals.js";
import { buildParseArgv, getPrimaryCommand, hasHelpOrVersion } from "../argv.js";

function resolveActionArgs(command: Command | undefined): string[] {
  return command?.args ?? [];
}

type SubCliEntry = {
  name: string;
  description: string;
  register: (program: Command) => Promise<void> | void;
};

const entries: SubCliEntry[] = [
  {
    name: "plugins",
    description: "Plugin management (ElizaOS plugins)",
    register: async (program) => {
      const mod = await import("../plugins-cli.js");
      mod.registerPluginsCli(program);
    },
  },
  {
    name: "models",
    description: "Model configuration",
    register: async (program) => {
      const mod = await import("./register.models.js");
      mod.registerModelsCli(program);
    },
  },
];

function removeCommand(program: Command, command: Command) {
  const commands = program.commands as Command[];
  const index = commands.indexOf(command);
  if (index >= 0) {
    commands.splice(index, 1);
  }
}

export async function registerSubCliByName(program: Command, name: string): Promise<boolean> {
  const entry = entries.find((e) => e.name === name);
  if (!entry) {
    return false;
  }
  const existing = program.commands.find((cmd) => cmd.name() === entry.name);
  if (existing) {
    removeCommand(program, existing);
  }
  await entry.register(program);
  return true;
}

function registerLazyCommand(program: Command, entry: SubCliEntry) {
  const placeholder = program.command(entry.name).description(entry.description);
  placeholder.allowUnknownOption(true);
  placeholder.allowExcessArguments(true);
  placeholder.action(async (...actionArgs) => {
    removeCommand(program, placeholder);
    await entry.register(program);
    const actionCommand = actionArgs.at(-1) as Command | undefined;
    const root = actionCommand?.parent ?? program;
    const rawArgs = (root as Command & { rawArgs?: string[] }).rawArgs;
    const actionArgsList = resolveActionArgs(actionCommand);
    const fallbackArgv = actionCommand?.name()
      ? [actionCommand.name(), ...actionArgsList]
      : actionArgsList;
    const parseArgv = buildParseArgv({
      programName: program.name(),
      rawArgs,
      fallbackArgv,
    });
    await program.parseAsync(parseArgv);
  });
}

export function registerSubCliCommands(program: Command, argv: string[] = process.argv) {
  const eagerAll = isTruthyEnvValue(process.env.MILAIDY_DISABLE_LAZY_SUBCOMMANDS);

  if (eagerAll) {
    for (const entry of entries) {
      // Await is not possible in sync context; errors surface via unhandledRejection handler
      void entry.register(program);
    }
    return;
  }

  if (!hasHelpOrVersion(argv)) {
    const primary = getPrimaryCommand(argv);
    const entry = primary ? entries.find((e) => e.name === primary) : undefined;
    if (entry) {
      registerLazyCommand(program, entry);
      return;
    }
  }

  for (const entry of entries) {
    registerLazyCommand(program, entry);
  }
}
