/**
 * Registers every top-level `eliza` CLI command onto the Commander program —
 * start, benchmark, capability-router, setup, doctor, db, configure, config,
 * dashboard, update, auth, and models. Commands are registered synchronously;
 * actions own any lazy runtime imports.
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
import { registerModelsCli } from "./register.models";
import { registerSetupCommand } from "./register.setup";
import { registerStartCommand } from "./register.start";
import { registerUpdateCommand } from "./register.update";

export function registerProgramCommands(program: Command) {
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
  registerModelsCli(program);
}
