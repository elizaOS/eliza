/**
 * Minimal HTTP process for applying a verified schema-v2 snapshot before a
 * replacement agent boots. It intentionally exposes no normal API surface and
 * constructs no AgentRuntime, plugin graph, database adapter, registry, model,
 * WebSocket, or static-file host.
 */
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import {
  ElizaError,
  logger,
  sendJson,
  sendJsonError,
  validateUuid,
} from "@elizaos/core";
import { resolveStateDir } from "../config/paths.ts";
import {
  RESTORE_VALIDATION_BOOT_MODE,
  resolveRuntimeBootMode,
} from "../runtime/restore-validation-mode.ts";
import type { AgentSnapshotUpgradeBinding } from "../services/agent-backup.ts";
import { resolveCandidateSnapshotRestoreBinding } from "../services/agent-snapshot-restore-binding.ts";
import {
  type AgentSnapshotRestoreTarget,
  getAgentSnapshotRestoreStatus,
} from "../services/agent-snapshot-stream.ts";
import {
  handleCandidateSnapshotRestore,
  snapshotProtocolStatus,
} from "./candidate-snapshot-restore.ts";

const DEFAULT_RESTORE_VALIDATION_PORT = 2138;
const DEFAULT_RESTORE_VALIDATION_HOST = "127.0.0.1";

type RestoreServerPhase = "accepting" | "applying" | "failed" | "standby";

export interface RestoreValidationServer {
  close(): Promise<void>;
  readonly host: string;
  readonly port: number;
  readonly server: http.Server;
  readonly url: string;
}

export interface RestoreValidationServerOptions {
  host?: string;
  installSignalHandlers?: boolean;
  port?: number;
}

function startupError(message: string, code: string): ElizaError {
  return new ElizaError(message, {
    code,
    severity: "fatal",
  });
}

function resolveRestoreValidationBinding(
  env: NodeJS.ProcessEnv,
): AgentSnapshotUpgradeBinding {
  const binding = resolveCandidateSnapshotRestoreBinding(env);
  if (!binding) {
    throw startupError(
      "Restore-validation boot requires a complete candidate snapshot binding",
      "AGENT_SNAPSHOT_RESTORE_NOT_ENABLED",
    );
  }
  return binding;
}

function resolveRestoreValidationPort(
  env: NodeJS.ProcessEnv,
  override: number | undefined,
): number {
  if (override === 0) return 0;
  const raw =
    override ??
    env.ELIZA_API_PORT?.trim() ??
    env.ELIZA_PORT?.trim() ??
    env.PORT?.trim() ??
    DEFAULT_RESTORE_VALIDATION_PORT;
  const port = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw startupError(
      `Restore-validation API port is invalid: ${String(raw)}`,
      "RESTORE_VALIDATION_PORT_INVALID",
    );
  }
  return port;
}

function createRestoreTarget(
  env: NodeJS.ProcessEnv,
): AgentSnapshotRestoreTarget {
  const agentId = validateUuid(env.SANDBOX_ROUTE_AGENT_ID?.trim());
  if (!agentId) {
    throw startupError(
      "Restore-validation boot requires a valid SANDBOX_ROUTE_AGENT_ID",
      "RESTORE_VALIDATION_AGENT_ID_INVALID",
    );
  }
  return {
    agentId,
    restoreValidationOnly: true,
    getSetting(key) {
      const value = env[key]?.trim();
      return value || undefined;
    },
    async quiesceForRestore() {
      // This process owns no mutable runtime or open database handle. The
      // restore barrier still supplies the one-way apply/standby transition.
    },
  };
}

async function assertRestoreStateRoot(env: NodeJS.ProcessEnv): Promise<void> {
  const stateRoot = path.resolve(resolveStateDir(env));
  let stat: Awaited<ReturnType<typeof fs.lstat>>;
  try {
    stat = await fs.lstat(stateRoot);
    await fs.access(stateRoot, fsConstants.W_OK);
  } catch (cause) {
    // error-policy:J2 Restore readiness requires the provider-mounted state
    // root, so preserve the filesystem failure as the startup cause.
    throw new ElizaError("Restore-validation state root is unavailable", {
      cause,
      code: "RESTORE_VALIDATION_STATE_ROOT_INVALID",
      context: { stateRoot },
      severity: "fatal",
    });
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw startupError(
      "Restore-validation state root must be a durable directory",
      "RESTORE_VALIDATION_STATE_ROOT_INVALID",
    );
  }
}

function restoreHealthBody(
  target: AgentSnapshotRestoreTarget,
  phase: RestoreServerPhase,
): Record<string, unknown> {
  const barrier = getAgentSnapshotRestoreStatus(target);
  if (phase === "accepting") {
    return {
      activeMutations: barrier.activeMutations,
      canRespond: false,
      mode: RESTORE_VALIDATION_BOOT_MODE,
      ready: false,
      restorePhase: "accepting",
      restoreReady: true,
      status: "restore-ready",
    };
  }
  if (phase === "standby") {
    return {
      activeMutations: barrier.activeMutations,
      canRespond: false,
      mode: RESTORE_VALIDATION_BOOT_MODE,
      ready: false,
      requiresRestart: true,
      restorePhase: "standby",
      restoreReady: false,
      status: "restore-standby",
    };
  }
  return {
    activeMutations: barrier.activeMutations,
    canRespond: false,
    mode: RESTORE_VALIDATION_BOOT_MODE,
    ready: false,
    restorePhase: phase,
    restoreReady: false,
    status: phase === "applying" ? "restore-applying" : "restore-failed",
  };
}

function sendMethodNotAllowed(
  res: http.ServerResponse,
  allow: "GET" | "POST",
): void {
  res.setHeader("Allow", allow);
  sendJsonError(res, "Method not allowed", 405);
}

export async function startRestoreValidationServer(
  options: RestoreValidationServerOptions = {},
): Promise<RestoreValidationServer> {
  const env = process.env;
  if (resolveRuntimeBootMode(env) !== RESTORE_VALIDATION_BOOT_MODE) {
    throw startupError(
      "Restore-validation server requires ELIZA_RUNTIME_BOOT_MODE=restore-validation",
      "RUNTIME_BOOT_MODE_BOUNDARY_VIOLATION",
    );
  }
  const binding = resolveRestoreValidationBinding(env);
  const target = createRestoreTarget(env);
  await assertRestoreStateRoot(env);
  const requestedPort = resolveRestoreValidationPort(env, options.port);
  const host =
    options.host ??
    env.ELIZA_API_BIND?.trim() ??
    DEFAULT_RESTORE_VALIDATION_HOST;
  if (!host) {
    throw startupError(
      "Restore-validation API bind host is invalid",
      "RESTORE_VALIDATION_BIND_INVALID",
    );
  }

  let phase: RestoreServerPhase = "accepting";
  const server = http.createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", `http://${host}`);
      if (url.pathname === "/api/health") {
        if (req.method !== "GET") {
          sendMethodNotAllowed(res, "GET");
          return;
        }
        res.setHeader("Cache-Control", "no-store");
        sendJson(
          res,
          restoreHealthBody(target, phase),
          phase === "accepting" ? 200 : 503,
        );
        return;
      }
      if (url.pathname !== "/api/restore") {
        sendJsonError(res, "Not found", 404);
        return;
      }
      if (req.method !== "POST") {
        sendMethodNotAllowed(res, "POST");
        return;
      }

      let applyStarted = false;
      try {
        await handleCandidateSnapshotRestore({
          binding,
          onApplyStarted: () => {
            applyStarted = true;
            phase = "applying";
          },
          req,
          res,
          runtime: target,
          url,
        });
        phase = "standby";
      } catch (error) {
        // error-policy:J1 The only restore process transport boundary maps
        // protocol errors to JSON and keeps post-receipt failures unavailable.
        if (applyStarted) phase = "failed";
        logger.error({ error }, "[restore-validation] Restore request failed");
        sendJsonError(
          res,
          error instanceof Error ? error.message : "Restore failed",
          snapshotProtocolStatus(error),
        );
      }
    })().catch((error) => {
      // error-policy:J1 A request handler bug remains observable and cannot
      // escape as an unhandled rejection in the restore-only process.
      phase = "failed";
      logger.error({ error }, "[restore-validation] HTTP boundary failed");
      if (!res.headersSent) {
        sendJsonError(res, "Restore-validation request failed", 500);
      } else {
        res.destroy(error instanceof Error ? error : undefined);
      }
    });
  });
  // The controller owns the bounded transfer deadline. Node's request timeout
  // would otherwise abort a valid large snapshot mid-stream without a durable
  // protocol result.
  server.requestTimeout = 0;
  server.timeout = 0;
  server.headersTimeout = 60_000;
  server.keepAliveTimeout = 60_000;

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(requestedPort, host);
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw startupError(
      "Restore-validation server did not bind a TCP address",
      "RESTORE_VALIDATION_BIND_FAILED",
    );
  }

  const signalHandlers = new Map<NodeJS.Signals, () => void>();
  if (options.installSignalHandlers !== false) {
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      const handler = (): void => {
        server.close((error) => {
          if (error) {
            logger.error(
              { error, signal },
              "[restore-validation] Server shutdown failed",
            );
            process.exitCode = 1;
          }
        });
      };
      signalHandlers.set(signal, handler);
      process.once(signal, handler);
    }
  }

  const close = async (): Promise<void> => {
    for (const [signal, handler] of signalHandlers) {
      process.off(signal, handler);
    }
    signalHandlers.clear();
    if (!server.listening) return;
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  };
  const url = `http://${host}:${address.port}`;
  logger.info(
    { agentId: target.agentId, host, port: address.port },
    "[restore-validation] Listening",
  );
  return { close, host, port: address.port, server, url };
}

export async function startRestoreValidationProcess(): Promise<void> {
  await startRestoreValidationServer({ installSignalHandlers: true });
}
