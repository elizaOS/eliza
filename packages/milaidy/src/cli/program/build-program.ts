import { Command } from "commander";
import { VERSION } from "../../version.js";
import { registerProgramCommands } from "./command-registry.js";
import { configureProgramHelp } from "./help.js";
import { registerPreActionHooks } from "./preaction.js";

export function buildProgram() {
  const program = new Command();

  configureProgramHelp(program, VERSION);
  registerPreActionHooks(program, VERSION);
  registerProgramCommands(program);

  return program;
}
