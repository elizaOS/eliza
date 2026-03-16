import type { Command } from "commander";
import { registerConfigCli } from "./register.config.js";
import { registerConfigureCommand } from "./register.configure.js";
import { registerDashboardCommand } from "./register.dashboard.js";
import { registerSetupCommand } from "./register.setup.js";
import { registerStartCommand } from "./register.start.js";
import { registerSubCliCommands } from "./register.subclis.js";

export function registerProgramCommands(program: Command, argv: string[] = process.argv) {
  registerStartCommand(program);
  registerSetupCommand(program);
  registerConfigureCommand(program);
  registerConfigCli(program);
  registerDashboardCommand(program);
  registerSubCliCommands(program, argv);
}
