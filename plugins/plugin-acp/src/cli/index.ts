/**
 * ACP CLI module
 *
 * Provides CLI commands for the Agent Client Protocol plugin.
 * Self-registers with the plugin-cli registry at module load.
 */

import {
  type CliContext,
  defineCliCommand,
  registerCliCommand,
} from "@elizaos/plugin-cli";
import { registerAcpCli } from "./register.js";

// Self-register at module load
registerCliCommand(
  defineCliCommand(
    "acp",
    "Agent Client Protocol (ACP) bridge and client commands",
    (ctx: CliContext) => registerAcpCli(ctx),
    { priority: 50 },
  ),
);
