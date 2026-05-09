import crypto from "node:crypto";
import {
  isLoopbackBindHost,
  resolveApiBindHost,
  resolveApiSecurityConfig,
  resolveApiToken,
  resolveServerOnlyPort,
  setApiToken,
} from "@elizaos/shared";
import type { Command } from "commander";
import { formatDocsLink } from "..//shared";
import { theme } from "..//shared";
import { runCommandWithRuntime } from "../cli-utils";

const defaultRuntime = { error: console.error, exit: process.exit };

/**
 * Generate a random connection key for remote access.
 * Only called when explicitly requested via --connection-key flag
 * without a value, or when binding to a non-localhost address.
 */
function generateConnectionKey(): string {
  const generated = crypto.randomBytes(16).toString("hex");
  setApiToken(process.env, generated);
  return generated;
}

/**
 * Check if the server is binding to a network-accessible address
 * (not localhost), which requires a connection key for security.
 */
function isNetworkBind(): boolean {
  return !isLoopbackBindHost(resolveApiBindHost(process.env));
}

function shouldDisableAutoConnectionKey(): boolean {
  return resolveApiSecurityConfig(process.env).disableAutoApiToken;
}

async function startAction() {
  // Auto-generate a connection key only when binding to a network address
  // and no token is already configured. Localhost access stays open.
  const existingToken = resolveApiToken(process.env);

  if (!existingToken && isNetworkBind() && !shouldDisableAutoConnectionKey()) {
    generateConnectionKey();
  }

  const connectionKey = resolveApiToken(process.env);

  await runCommandWithRuntime(defaultRuntime, async () => {
    const { startEliza } = await import("../../runtime/eliza");
    const { ensureAuthPairingCodeForRemoteAccess } = await import(
      "../../api/auth-pairing-compat-routes"
    );
    // Use serverOnly mode: starts API server, no interactive chat loop
    await startEliza({
      serverOnly: true,
      onEmbeddingProgress: (phase, detail) => {
        if (phase === "downloading") {
          console.log(`[eliza] Embedding: ${detail ?? "downloading..."}`);
        } else if (phase === "ready") {
          console.log(`[eliza] Embedding model ready`);
        }
      },
    });

    const port = String(resolveServerOnlyPort(process.env));
    const pairing = ensureAuthPairingCodeForRemoteAccess();
    console.log("");
    console.log("╭──────────────────────────────────────────╮");
    console.log("│  Server is running.                      │");
    console.log("│                                          │");
    console.log(`│  Connect at: http://localhost:${port.padEnd(13)}│`);
    if (connectionKey) {
      console.log(
        `│  Connection key: ${("*".repeat(Math.max(0, connectionKey.length - 4)) + connectionKey.slice(-4)).padEnd(22)}│`,
      );
    }
    if (pairing) {
      console.log(`│  Pairing code: ${pairing.code.padEnd(24)}│`);
    }
    console.log("╰──────────────────────────────────────────╯");
    console.log("");
  });
}

export function registerStartCommand(program: Command) {
  program
    .command("start")
    .description("Start the elizaOS agent runtime")
    .option(
      "--connection-key [key]",
      "Set or auto-generate a connection key for remote access",
    )
    .addHelpText(
      "after",
      () =>
        `\n${theme.muted("Docs:")} ${formatDocsLink("/getting-started", "docs.eliza.ai/getting-started")}\n`,
    )
    .action(async (opts: { connectionKey?: string | boolean }) => {
      if (typeof opts.connectionKey === "string" && opts.connectionKey) {
        // Explicit key provided
        setApiToken(process.env, opts.connectionKey);
      } else if (opts.connectionKey === true) {
        // Flag passed without value — auto-generate
        generateConnectionKey();
      }
      await startAction();
    });

  program
    .command("run")
    .description("Alias for start")
    .option(
      "--connection-key [key]",
      "Set or auto-generate a connection key for remote access",
    )
    .action(async (opts: { connectionKey?: string | boolean }) => {
      if (typeof opts.connectionKey === "string" && opts.connectionKey) {
        setApiToken(process.env, opts.connectionKey);
      } else if (opts.connectionKey === true) {
        generateConnectionKey();
      }
      await startAction();
    });
}
