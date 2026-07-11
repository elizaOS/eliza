/**
 * Registers every top-level `eliza` CLI command onto the Commander program —
 * start, benchmark, capability-router, setup, doctor, db, configure, config,
 * dashboard, update, auth, and the delegated sub-CLIs — each defined in its own
 * `register.<name>` module. Sub-CLI registration receives argv for lazy
 * dispatch.
 */
import type { Command } from "commander";
import { registerAuthCommand } from "./register.auth";
import { registerAuthAdoptCodexSubcommand } from "./register.auth.adopt-codex";
import { registerBenchmarkCommand } from "./register.benchmark";
import { registerCapabilityRouterCommand } from "./register.capability-router";
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
  registerCapabilityRouterCommand(program);
  registerSetupCommand(program);
  registerDoctorCommand(program);
  registerDbCommand(program);
  registerConfigureCommand(program);
  registerConfigCli(program);
  registerDashboardCommand(program);
  registerUpdateCommand(program);
  registerAuthCommand(program);
  registerAuthAdoptCodexSubcommand(program);
  registerSubCliCommands(program, argv);
}
