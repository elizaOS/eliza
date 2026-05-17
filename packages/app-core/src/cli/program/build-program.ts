import { Command } from "commander";
import { CLI_VERSION } from "../version";
import { registerProgramCommands } from "./command-registry";
import { configureProgramHelp } from "./help";
import { registerPreActionHooks } from "./preaction";

export function buildProgram() {
  const program = new Command();

  configureProgramHelp(program, CLI_VERSION);
  registerPreActionHooks(program, CLI_VERSION);
  registerProgramCommands(program);

  return program;
}
