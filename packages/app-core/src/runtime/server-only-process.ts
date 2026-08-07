/**
 * Owns operating-system signal handling for a server-only app-core host. The
 * runtime bootstrap exposes a closeable host; only CLI/process entrypoints use
 * this adapter to translate SIGINT and SIGTERM into bounded shutdown and exit.
 */
import { logger } from "@elizaos/core";

export interface ServerOnlyHost {
  readonly port: number;
  getRuntime(): unknown;
  close(): Promise<void>;
}

interface ProcessControl {
  once(signal: NodeJS.Signals, listener: () => void): unknown;
  off(signal: NodeJS.Signals, listener: () => void): unknown;
  exit(code: number): void;
}

export interface ServerOnlyProcessOwner {
  shutdown(signal?: NodeJS.Signals): Promise<void>;
  dispose(): void;
}

export function installServerOnlyProcessOwner(
  host: ServerOnlyHost,
  control: ProcessControl = process,
  shutdownTimeoutMs = 10_000,
): ServerOnlyProcessOwner {
  let closing = false;

  const shutdown = async (signal?: NodeJS.Signals): Promise<void> => {
    if (closing) return;
    closing = true;

    let timedOut = false;
    const forceExitTimer = setTimeout(() => {
      timedOut = true;
      logger.error(
        `[ServerOnlyProcess] Shutdown timed out after ${shutdownTimeoutMs}ms`,
      );
      control.exit(1);
    }, shutdownTimeoutMs);
    forceExitTimer.unref();

    let exitCode = 0;
    try {
      await host.close();
      clearTimeout(forceExitTimer);
      if (timedOut) return;
      logger.info(
        `[ServerOnlyProcess] Shutdown complete${signal ? ` (${signal})` : ""}`,
      );
    } catch (error) {
      // error-policy:J1 process boundary — translate shutdown failure into a
      // non-zero process result after logging the underlying failure.
      clearTimeout(forceExitTimer);
      if (timedOut) return;
      logger.error({ error }, "[ServerOnlyProcess] Graceful shutdown failed");
      exitCode = 1;
    }
    control.exit(exitCode);
  };

  const onSigint = () => void shutdown("SIGINT");
  const onSigterm = () => void shutdown("SIGTERM");
  control.once("SIGINT", onSigint);
  control.once("SIGTERM", onSigterm);

  return {
    shutdown,
    dispose() {
      control.off("SIGINT", onSigint);
      control.off("SIGTERM", onSigterm);
    },
  };
}
