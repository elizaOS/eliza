import type { CliContext } from "@elizaos/plugin-cli";
import { runAcpClientInteractive } from "../client.js";
import {
  ACP_SERVICE_TYPE,
  type ACPService,
  serveAcpGateway,
} from "../service.js";

interface AcpServerOpts {
  url?: string;
  token?: string;
  password?: string;
  session?: string;
  sessionLabel?: string;
  requireExisting?: boolean;
  resetSession?: boolean;
  prefixCwd?: boolean;
  verbose?: boolean;
}

interface AcpClientOpts {
  cwd?: string;
  server?: string;
  serverArgs?: string[];
  serverVerbose?: boolean;
  verbose?: boolean;
}

interface AcpStatusOpts {
  json?: boolean;
}

/**
 * Get the ACP service from runtime
 */
async function getAcpService(ctx: CliContext): Promise<ACPService | null> {
  const runtime = ctx.getRuntime?.();
  if (!runtime) {
    return null;
  }
  return await runtime.getService<ACPService>(ACP_SERVICE_TYPE);
}

/**
 * Register ACP CLI commands
 *
 * Commands:
 * - acp: Run an ACP bridge backed by the Gateway
 * - acp client: Run an interactive ACP client
 * - acp status: Show ACP service status
 *
 * @param ctx - CLI context with program and optional runtime
 */
export function registerAcpCli(ctx: CliContext): void {
  const acp = ctx.program
    .command("acp")
    .description("Run an ACP bridge backed by the Gateway");

  // Main ACP server command (the parent command action)
  acp
    .option(
      "--url <url>",
      "Gateway WebSocket URL (defaults to gateway.remote.url when configured)",
    )
    .option("--token <token>", "Gateway token (if required)")
    .option("--password <password>", "Gateway password (if required)")
    .option("--session <key>", "Default session key (e.g. agent:main:main)")
    .option("--session-label <label>", "Default session label to resolve")
    .option(
      "--require-existing",
      "Fail if the session key/label does not exist",
      false,
    )
    .option("--reset-session", "Reset the session key before first use", false)
    .option(
      "--no-prefix-cwd",
      "Do not prefix prompts with the working directory",
      false,
    )
    .option("--verbose, -v", "Verbose logging to stderr", false)
    .action(async (opts: AcpServerOpts) => {
      const service = await getAcpService(ctx);

      if (service) {
        // Use the service if available (runtime connected)
        service.startServer({
          gatewayUrl: opts.url,
          gatewayToken: opts.token,
          gatewayPassword: opts.password,
          defaultSessionKey: opts.session,
          defaultSessionLabel: opts.sessionLabel,
          requireExistingSession: Boolean(opts.requireExisting),
          resetSession: Boolean(opts.resetSession),
          prefixCwd: opts.prefixCwd !== false,
          verbose: Boolean(opts.verbose),
        });
      } else {
        // Fallback to standalone function (no runtime)
        serveAcpGateway({
          gatewayUrl: opts.url,
          gatewayToken: opts.token,
          gatewayPassword: opts.password,
          defaultSessionKey: opts.session,
          defaultSessionLabel: opts.sessionLabel,
          requireExistingSession: Boolean(opts.requireExisting),
          resetSession: Boolean(opts.resetSession),
          prefixCwd: opts.prefixCwd !== false,
          verbose: Boolean(opts.verbose),
        });
      }
    });

  // ACP client subcommand
  acp
    .command("client")
    .description("Run an interactive ACP client against the local ACP bridge")
    .option("--cwd <dir>", "Working directory for the ACP session")
    .option("--server <command>", "ACP server command (default: elizaos)")
    .option("--server-args <args...>", "Extra arguments for the ACP server")
    .option(
      "--server-verbose",
      "Enable verbose logging on the ACP server",
      false,
    )
    .option("--verbose, -v", "Verbose client logging", false)
    .action(async (opts: AcpClientOpts) => {
      await runAcpClientInteractive({
        cwd: opts.cwd,
        serverCommand: opts.server,
        serverArgs: opts.serverArgs,
        serverVerbose: Boolean(opts.serverVerbose),
        verbose: Boolean(opts.verbose),
      });
    });

  // ACP status subcommand
  acp
    .command("status")
    .description("Show ACP service status")
    .option("--json", "Output as JSON", false)
    .action(async (opts: AcpStatusOpts) => {
      const service = await getAcpService(ctx);

      const status = {
        serviceAvailable: service !== null,
        serverRunning: service?.isServerRunning() ?? false,
        config: service?.getConfig() ?? null,
      };

      if (opts.json) {
        console.log(JSON.stringify(status, null, 2));
      } else {
        console.log("ACP Service Status:");
        console.log(`  Service available: ${status.serviceAvailable}`);
        console.log(`  Server running: ${status.serverRunning}`);
        if (status.config) {
          console.log("  Configuration:");
          console.log(
            `    Gateway URL: ${status.config.gatewayUrl ?? "(default)"}`,
          );
          console.log(`    Verbose: ${status.config.verbose ?? false}`);
        }
      }
    });
}
