import type { Command } from "commander";
import { registerAuthCommand } from "./register.auth";
import { registerBenchmarkCommand } from "./register.benchmark";
import { registerConfigCli } from "./register.config";
import { registerConfigureCommand } from "./register.configure";
import { registerDashboardCommand } from "./register.dashboard";
import { registerDbCommand } from "./register.db";
import { registerDoctorCommand } from "./register.doctor";
import { registerSetupCommand } from "./register.setup";
import { registerStartCommand } from "./register.start";
import { registerSubCliCommands } from "./register.subclis";
import { registerUpdateCommand } from "./register.update";

export function registerProgramCommands(
  program: Command,
  argv: string[] = process.argv,
) {
  registerStartCommand(program);
  registerBenchmarkCommand(program);
  registerSetupCommand(program);
  registerDoctorCommand(program);
  registerDbCommand(program);
  registerConfigureCommand(program);
  registerConfigCli(program);
  registerDashboardCommand(program);
  registerUpdateCommand(program);
  registerAuthCommand(program);
  registerSubCliCommands(program, argv);
}
