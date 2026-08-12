/** Polls one hosted agent while the create flow waits for a terminal state. */

import type { AgentSandboxStatus } from "@elizaos/cloud-shared/lib/types/cloud-api";
import { agentResponseSchema } from "@elizaos/cloud-shared/types/agent-api-schema";
import { useCallback, useEffect, useRef, useState } from "react";

export type SandboxStatus = AgentSandboxStatus;

export interface SandboxStatusResult {
  status: SandboxStatus;
  lastHeartbeat: string | null;
  error: string | null;
  isLoading: boolean;
}

const TERMINAL_STATES = new Set<SandboxStatus>([
  "running",
  "stopped",
  "sleeping",
  "disconnected",
  "error",
  "deletion_pending",
  "deletion_failed",
]);
const MAX_CONSECUTIVE_ERRORS = 5;

export function useSandboxStatusPoll(
  agentId: string | null,
  options: {
    intervalMs?: number;
    enabled?: boolean;
  } = {},
) {
  const { intervalMs = 5_000, enabled = true } = options;
  const [result, setResult] = useState<SandboxStatusResult>({
    status: "pending",
    lastHeartbeat: null,
    error: null,
    isLoading: false,
  });

  const cancelledRef = useRef(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const statusRef = useRef<SandboxStatus>("pending");
  const consecutiveErrorsRef = useRef(0);

  const cleanup = useCallback(() => {
    cancelledRef.current = true;
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (!agentId || !enabled) {
      cleanup();
      return;
    }

    cancelledRef.current = false;
    consecutiveErrorsRef.current = 0;

    const poll = async () => {
      if (cancelledRef.current) return;
      if (TERMINAL_STATES.has(statusRef.current)) {
        cleanup();
        return;
      }
      if (
        typeof document !== "undefined" &&
        document.visibilityState !== "visible"
      )
        return;

      setResult((prev) => ({ ...prev, isLoading: true }));

      try {
        const res = await fetch(`/api/v1/eliza/agents/${agentId}`);
        if (cancelledRef.current) return;

        if (!res.ok) {
          consecutiveErrorsRef.current++;
          setResult((prev) => ({
            ...prev,
            isLoading: false,
            error: `HTTP ${res.status}`,
          }));
          if (
            (res.status >= 400 && res.status < 500) ||
            consecutiveErrorsRef.current >= MAX_CONSECUTIVE_ERRORS
          ) {
            cleanup();
          }
          return;
        }

        consecutiveErrorsRef.current = 0;

        const data = agentResponseSchema.parse(await res.json()).data;
        const newStatus = data.status;
        statusRef.current = newStatus;

        setResult({
          status: newStatus,
          lastHeartbeat: data.lastHeartbeatAt,
          error: data.errorMessage,
          isLoading: false,
        });

        if (TERMINAL_STATES.has(newStatus)) {
          cleanup();
        }
      } catch {
        // error-policy:J4 the status card shows its retained state while a
        // bounded retry counter makes repeated transport/contract failure stop.
        if (!cancelledRef.current) {
          consecutiveErrorsRef.current++;
          setResult((prev) => ({
            ...prev,
            isLoading: false,
            error: "Unable to refresh agent status",
          }));
          if (consecutiveErrorsRef.current >= MAX_CONSECUTIVE_ERRORS) {
            cleanup();
          }
        }
      }
    };

    void poll();

    intervalRef.current = setInterval(() => void poll(), intervalMs);

    return cleanup;
  }, [agentId, enabled, intervalMs, cleanup]);

  return result;
}
