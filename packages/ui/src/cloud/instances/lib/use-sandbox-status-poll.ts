/**
 * Agent / sandbox status polling hooks.
 *
 * - {@link useSandboxStatusPoll} polls a single agent until it reaches a
 *   terminal state (used by the create-agent dialog's progress view).
 * - {@link useSandboxListPoll} polls the agent list endpoint while any agent is
 *   active, pushing the fresh list to the parent so the table updates in place
 *   (no page reload) and firing a "now running" callback on transitions.
 */

import type { AgentListItemDto } from "@elizaos/cloud-shared/lib/types/cloud-api";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../lib/api-client";
import { parseAgentsResponse } from "./data/eliza-agents";

export type SandboxStatus =
  | "pending"
  | "provisioning"
  | "running"
  | "stopped"
  | "sleeping"
  | "disconnected"
  | "error";

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
  "error",
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
    statusRef.current = "pending";
    consecutiveErrorsRef.current = 0;
    // Reset the visible result too, not just the ref. Otherwise the previous
    // agent's terminal status stays on screen and is attributed to the new one
    // — and if the new agent's first fetch fails, the catch only bumps an error
    // counter, so that borrowed "running" persists indefinitely. A status we
    // have not loaded must not render as a healthy one we did.
    setResult({
      status: "pending",
      lastHeartbeat: null,
      error: null,
      isLoading: true,
    });

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

    void poll();

    intervalRef.current = setInterval(() => void poll(), intervalMs);

    return cleanup;
  }, [agentId, enabled, intervalMs, cleanup]);

  return result;
}

export function useSandboxListPoll(
  sandboxes: Array<{ id: string; status: string }>,
  options: {
    intervalMs?: number;
    onTransitionToRunning?: (agentId: string, agentName: string | null) => void;
    /** Called on every successful poll with the full agent list from the API. */
    onDataRefresh?: (agents: AgentListItemDto[]) => void;
  } = {},
) {
  const { intervalMs = 10_000, onTransitionToRunning, onDataRefresh } = options;
  const [isPolling, setIsPolling] = useState(false);
  const previousStatusesRef = useRef<Map<string, string>>(new Map());
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
    const statusMap = new Map<string, string>();
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

  const hasActiveAgents = sandboxes.some((sb) =>
    ACTIVE_STATES.has(sb.status as SandboxStatus),
  );

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
    let requestGeneration = 0;
    let requestController: AbortController | null = null;

    const poll = async () => {
      if (cancelled) return;
      if (
        typeof document !== "undefined" &&
        document.visibilityState !== "visible"
      )
        return;

      const generation = ++requestGeneration;
      requestController?.abort();
      const controller = new AbortController();
      requestController = controller;

      try {
        const payload = await api<unknown>("/api/v1/eliza/agents", {
          signal: controller.signal,
        });
        if (cancelled || generation !== requestGeneration) return;
        const agents = parseAgentsResponse(payload);

        dataRefreshRef.current?.(agents);

        for (const agent of agents) {
          const prevStatus = previousStatusesRef.current.get(agent.id);
          const newStatus = agent.status;

          if (
            prevStatus &&
            ACTIVE_STATES.has(prevStatus as SandboxStatus) &&
            newStatus === "running"
          ) {
            callbackRef.current?.(agent.id, agent.agentName);
          }

          previousStatusesRef.current.set(agent.id, newStatus);
        }
      } catch (error) {
        // error-policy:J4 a failed background refresh leaves the last visible
        // authoritative list intact and retries on the next interval.
        if (error instanceof DOMException && error.name === "AbortError")
          return;
      }
    };

    void poll();

    intervalRef.current = setInterval(() => void poll(), intervalMs);

    return () => {
      cancelled = true;
      requestGeneration++;
      requestController?.abort();
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [hasActiveAgents, intervalMs]);

  return { isPolling };
}
