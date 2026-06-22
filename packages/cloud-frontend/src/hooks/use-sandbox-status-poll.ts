"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export type SandboxStatus =
  | "pending"
  | "provisioning"
  | "running"
  | "stopped"
  | "disconnected"
  | "error";

export interface SandboxStatusResult {
  status: SandboxStatus;
  lastHeartbeat: string | null;
  error: string | null;
  isLoading: boolean;
}

const TERMINAL_STATES = new Set<SandboxStatus>(["running", "stopped", "error"]);
const MAX_CONSECUTIVE_ERRORS = 5;

/**
 * Polls a single agent's status while it's in a non-terminal state.
 * Stops automatically when the agent reaches "running", "stopped", or "error".
 */
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
          // Stop polling on persistent client errors (4xx) or too many consecutive failures
          if (
            (res.status >= 400 && res.status < 500) ||
            consecutiveErrorsRef.current >= MAX_CONSECUTIVE_ERRORS
          ) {
            cleanup();
          }
          return;
        }

        // Reset error counter on success
        consecutiveErrorsRef.current = 0;

        const json = await res.json();
        const data = json?.data;
        if (!data) return;

        const newStatus = (data.status as SandboxStatus) ?? "pending";
        statusRef.current = newStatus;

        setResult({
          status: newStatus,
          lastHeartbeat: data.lastHeartbeatAt ?? null,
          error: data.errorMessage ?? null,
          isLoading: false,
        });

        // Stop polling once we've reached a terminal state
        if (TERMINAL_STATES.has(newStatus)) {
          cleanup();
        }
      } catch {
        if (!cancelledRef.current) {
          consecutiveErrorsRef.current++;
          setResult((prev) => ({ ...prev, isLoading: false }));
          if (consecutiveErrorsRef.current >= MAX_CONSECUTIVE_ERRORS) {
            cleanup();
          }
        }
      }
    };

    // Initial poll
    void poll();

    // Set up interval
    intervalRef.current = setInterval(() => void poll(), intervalMs);

    return cleanup;
  }, [agentId, enabled, intervalMs, cleanup]);

  return result;
}
