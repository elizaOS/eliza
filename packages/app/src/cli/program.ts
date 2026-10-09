/**
 * Assembles the root Commander program for the `eliza` CLI: applies help and
 * banner formatting, registers the pre-action hooks, and wires in every
 * top-level command, returning the ready-to-parse program stamped with
 * CLI_VERSION.
 */
import { Command } from "commander";
import { registerProgramCommands } from "./program/command-registry";
import { configureProgramHelp } from "./program/help";
import { registerPreActionHooks } from "./program/preaction";
import { CLI_VERSION } from "./version";

export function buildProgram() {
  const program = new Command();

  configureProgramHelp(program, CLI_VERSION);
  registerPreActionHooks(program, CLI_VERSION);
  registerProgramCommands(program);

  return program;
}
