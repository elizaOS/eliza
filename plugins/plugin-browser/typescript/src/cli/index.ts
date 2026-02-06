/**
 * Browser CLI module
 *
 * Provides CLI commands for the browser automation plugin.
 * Self-registers with the plugin-cli registry at module load.
 */

import { defineCliCommand, registerCliCommand } from "@elizaos/plugin-cli";
import { registerBrowserCli } from "./register.js";

// Self-register at module load
registerCliCommand(
  defineCliCommand("browser", "Browser automation commands", (ctx) => registerBrowserCli(ctx), {
    priority: 50,
  })
);
