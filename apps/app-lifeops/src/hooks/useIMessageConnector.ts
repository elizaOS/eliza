import { client } from "@elizaos/app-core/api";
import type { LifeOpsIMessageConnectorStatus } from "@elizaos/shared/contracts/lifeops";
import { useCallback, useEffect, useState } from "react";
import type { FullDiskAccessProbeResult } from "../lifeops/fda-probe.js";

const TERMINAL_CAPTURE_TIMEOUT_MS = 6 * 60 * 1000;
const AGENT_RESTART_TIMEOUT_MS = 45 * 1000;
const INSTALL_IMSG_COMMAND =
  'if [ -x /opt/homebrew/bin/brew ]; then BREW_BIN=/opt/homebrew/bin/brew; elif [ -x /usr/local/bin/brew ]; then BREW_BIN=/usr/local/bin/brew; elif command -v brew >/dev/null 2>&1; then BREW_BIN="$(command -v brew)"; else echo "Homebrew is not installed on this Mac."; exit 127; fi; "$BREW_BIN" install steipete/tap/imsg';
const RESOLVE_IMSG_PATH_COMMAND =
  'if [ -x /opt/homebrew/bin/imsg ]; then printf "%s\\n" /opt/homebrew/bin/imsg; elif [ -x /usr/local/bin/imsg ]; then printf "%s\\n" /usr/local/bin/imsg; elif command -v imsg >/dev/null 2>&1; then command -v imsg; else echo "imsg is not available on PATH."; exit 1; fi';

type TerminalRunResponse = {
  ok: boolean;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  timedOut?: boolean;
  truncated?: boolean;
  maxDurationMs?: number;
};

function formatError(cause: unknown, fallback: string): string {
  if (cause instanceof Error && cause.message.trim().length > 0) {
    return cause.message.trim();
  }
  return fallback;
}

function formatTerminalFailure(
  commandLabel: string,
  result: TerminalRunResponse,
): string {
  if (result.timedOut) {
    return `${commandLabel} timed out before it could finish.`;
  }

  const stderr = result.stderr?.trim();
  if (stderr) {
    return stderr;
  }

  const stdout = result.stdout?.trim();
  if (stdout) {
    return stdout;
  }

  return `${commandLabel} exited with code ${result.exitCode ?? 1}.`;
}

function extractCliPath(stdout: string | undefined): string | null {
  const trimmed = stdout?.trim();
  if (!trimmed) {
    return null;
  }
  const lines = trimmed
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return lines.at(-1) ?? null;
}

function isMacHostPlatform(
  platform: LifeOpsIMessageConnectorStatus["hostPlatform"] | null | undefined,
): boolean {
  return platform === "darwin";
}

async function runCapturedTerminalCommand(
  command: string,
): Promise<TerminalRunResponse> {
  return client.fetch<TerminalRunResponse>(
    "/api/terminal/run",
    {
      method: "POST",
      body: JSON.stringify({
        command,
        captureOutput: true,
      }),
    },
    { timeoutMs: TERMINAL_CAPTURE_TIMEOUT_MS },
  );
}

export function useIMessageConnector() {
  const [status, setStatus] = useState<LifeOpsIMessageConnectorStatus | null>(
    null,
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [shellEnabled, setShellEnabled] = useState<boolean | null>(null);
  const [fullDiskAccess, setFullDiskAccess] =
    useState<FullDiskAccessProbeResult | null>(null);
  const [actionPending, setActionPending] = useState<"install_imsg" | null>(
    null,
  );

  const refreshSupportState = useCallback(
    async (nextStatus: LifeOpsIMessageConnectorStatus | null) => {
      if (!isMacHostPlatform(nextStatus?.hostPlatform)) {
        setShellEnabled(null);
        setFullDiskAccess(null);
        return;
      }

      const [shellResult, fullDiskAccessResult] = await Promise.allSettled([
        client.isShellEnabled(),
        client.getLifeOpsFullDiskAccessStatus(),
      ]);

      setShellEnabled(
        shellResult.status === "fulfilled" ? shellResult.value : null,
      );
      setFullDiskAccess(
        fullDiskAccessResult.status === "fulfilled"
          ? fullDiskAccessResult.value
          : null,
      );
    },
    [],
  );

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const nextStatus = await client.getIMessageConnectorStatus();
      setStatus(nextStatus);
      setError(null);
      await refreshSupportState(nextStatus);
    } catch (cause) {
      setError(formatError(cause, "iMessage connector status failed to load."));
    } finally {
      setLoading(false);
    }
  }, [refreshSupportState]);

  const installImsg = useCallback(async () => {
    if (!isMacHostPlatform(status?.hostPlatform)) {
      const message =
        "Automatic imsg setup is only available when the agent is running on a Mac.";
      setError(message);
      throw new Error(message);
    }

    if (shellEnabled === false) {
      const message =
        "Shell access is turned off. Enable it in Settings so Milady can install imsg for you.";
      setError(message);
      throw new Error(message);
    }

    setActionPending("install_imsg");
    setError(null);

    try {
      const installResult =
        await runCapturedTerminalCommand(INSTALL_IMSG_COMMAND);
      if (!installResult.ok || installResult.exitCode !== 0) {
        throw new Error(
          formatTerminalFailure("imsg installation", installResult),
        );
      }

      const resolvePathResult = await runCapturedTerminalCommand(
        RESOLVE_IMSG_PATH_COMMAND,
      );
      if (!resolvePathResult.ok || resolvePathResult.exitCode !== 0) {
        throw new Error(
          formatTerminalFailure("imsg path detection", resolvePathResult),
        );
      }

      const cliPath = extractCliPath(resolvePathResult.stdout);
      if (!cliPath) {
        throw new Error(
          "Milady installed imsg, but could not resolve its CLI path.",
        );
      }

      await client.updateConfig({
        connectors: {
          imessage: {
            cliPath,
            enabled: true,
          },
        },
      });

      await client.restartAndWait(AGENT_RESTART_TIMEOUT_MS);
      await refresh();
      return { cliPath };
    } catch (cause) {
      const message = formatError(cause, "imsg installation failed.");
      setError(message);
      throw new Error(message);
    } finally {
      setActionPending(null);
    }
  }, [refresh, shellEnabled, status?.hostPlatform]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return {
    status,
    loading,
    error,
    shellEnabled,
    fullDiskAccess,
    actionPending,
    refresh,
    installImsg,
  } as const;
}
