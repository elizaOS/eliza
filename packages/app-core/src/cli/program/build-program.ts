/**
 * Assembles the root Commander program for the `eliza` CLI: applies help and
 * banner formatting, registers the pre-action hooks, and wires in every
 * top-level command, returning the ready-to-parse program stamped with
 * CLI_VERSION.
 */
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
