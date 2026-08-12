/**
 * Agent / sandbox status polling hooks.
 *
 * - {@link useSandboxStatusPoll} polls a single agent until it reaches a
 *   terminal state (used by the create-agent dialog's progress view).
 * - {@link useSandboxListPoll} polls the agent list endpoint while any agent is
 *   active, pushing the fresh list to the parent so the table updates in place
 *   (no page reload) and firing a "now running" callback on transitions.
 */

import type {
  AgentListItemDto,
  AgentSandboxStatus,
} from "@elizaos/cloud-shared/lib/types/cloud-api";
import {
  agentResponseSchema,
  agentsResponseSchema,
} from "@elizaos/cloud-shared/types/agent-api-schema";
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
const ACTIVE_STATES = new Set<SandboxStatus>(["pending", "provisioning"]);
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

/** Canonical list row returned by the hosted-agent endpoint. */
export type SandboxListAgent = AgentListItemDto;

export function useSandboxListPoll(
  sandboxes: Array<{ id: string; status: AgentSandboxStatus }>,
  options: {
    intervalMs?: number;
    onTransitionToRunning?: (agentId: string, agentName: string | null) => void;
    /** Called on every successful poll with the full agent list from the API. */
    onDataRefresh?: (agents: SandboxListAgent[]) => void;
  } = {},
) {
  const { intervalMs = 10_000, onTransitionToRunning, onDataRefresh } = options;
  const [isPolling, setIsPolling] = useState(false);
  const previousStatusesRef = useRef<Map<string, AgentSandboxStatus>>(
    new Map(),
  );
  const callbackRef = useRef(onTransitionToRunning);
  const dataRefreshRef = useRef(onDataRefresh);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    callbackRef.current = onTransitionToRunning;
  }, [onTransitionToRunning]);

  useEffect(() => {
    dataRefreshRef.current = onDataRefresh;
  }, [onDataRefresh]);

  useEffect(() => {
    const statusMap = new Map<string, AgentSandboxStatus>();
    for (const sb of sandboxes) {
      if (!previousStatusesRef.current.has(sb.id)) {
        statusMap.set(sb.id, sb.status);
      } else {
        statusMap.set(
          sb.id,
          previousStatusesRef.current.get(sb.id) ?? sb.status,
        );
      }
    }
    previousStatusesRef.current = statusMap;
  }, [sandboxes]);

  const hasActiveAgents = sandboxes.some((sb) => ACTIVE_STATES.has(sb.status));

  useEffect(() => {
    if (!hasActiveAgents) {
      setIsPolling(false);
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      return;
    }

    setIsPolling(true);
    let cancelled = false;

    const poll = async () => {
      if (cancelled) return;
      if (
        typeof document !== "undefined" &&
        document.visibilityState !== "visible"
      )
        return;

      try {
        const res = await fetch("/api/v1/eliza/agents");
        if (cancelled || !res.ok) return;

        const agents = agentsResponseSchema.parse(await res.json()).data;

        dataRefreshRef.current?.(agents);

        for (const agent of agents) {
          const prevStatus = previousStatusesRef.current.get(agent.id);
          const newStatus = agent.status;

          if (
            prevStatus &&
            ACTIVE_STATES.has(prevStatus) &&
            newStatus === "running"
          ) {
            callbackRef.current?.(agent.id, agent.agentName);
          }

          previousStatusesRef.current.set(agent.id, newStatus);
        }
      } catch {
        // error-policy:J4 this active-row refresh is opportunistic; the primary
        // useAgents query owns the visible error state and retries independently.
      }
    };

    void poll();

    intervalRef.current = setInterval(() => void poll(), intervalMs);

    return () => {
      cancelled = true;
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [hasActiveAgents, intervalMs]);

  return { isPolling };
}
