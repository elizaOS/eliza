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
import { useEffect, useRef, useState } from "react";
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

  const effectGenerationRef = useRef(0);

  useEffect(() => {
    const effectGeneration = ++effectGenerationRef.current;
    let cancelled = false;
    let interval: ReturnType<typeof setInterval> | null = null;
    let status: SandboxStatus = "pending";
    let consecutiveErrors = 0;
    let requestGeneration = 0;
    let requestController: AbortController | null = null;

    const isCurrentEffect = () =>
      !cancelled && effectGenerationRef.current === effectGeneration;
    const stop = () => {
      cancelled = true;
      requestGeneration++;
      requestController?.abort();
      requestController = null;
      if (interval) {
        clearInterval(interval);
        interval = null;
      }
    };

    if (!agentId || !enabled) {
      stop();
      return stop;
    }

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
      if (!isCurrentEffect()) return;
      if (TERMINAL_STATES.has(status)) {
        stop();
        return;
      }
      if (
        typeof document !== "undefined" &&
        document.visibilityState !== "visible"
      )
        return;

      setResult((prev) => ({ ...prev, isLoading: true }));
      const generation = ++requestGeneration;
      requestController?.abort();
      const controller = new AbortController();
      requestController = controller;
      const timeoutSignal = AbortSignal.timeout(10_000);
      const abortForTimeout = () => controller.abort(timeoutSignal.reason);
      timeoutSignal.addEventListener("abort", abortForTimeout, { once: true });

      try {
        // Bound each poll hop so a hung status endpoint cannot leave
        // isLoading pinned forever (the error path only fires on rejection).
        const res = await fetch(`/api/v1/eliza/agents/${agentId}`, {
          signal: controller.signal,
        });
        if (!isCurrentEffect() || generation !== requestGeneration) return;

        if (!res.ok) {
          consecutiveErrors++;
          setResult((prev) => ({
            ...prev,
            isLoading: false,
            error: `HTTP ${res.status}`,
          }));
          if (
            (res.status >= 400 && res.status < 500) ||
            consecutiveErrors >= MAX_CONSECUTIVE_ERRORS
          ) {
            stop();
          }
          return;
        }

        consecutiveErrors = 0;

        const json = await res.json();
        if (!isCurrentEffect() || generation !== requestGeneration) return;
        const data = json?.data;
        if (!data) return;

        const newStatus = (data.status as SandboxStatus) ?? "pending";
        status = newStatus;

        setResult({
          status: newStatus,
          lastHeartbeat: data.lastHeartbeatAt ?? null,
          error: data.errorMessage ?? null,
          isLoading: false,
        });

        if (TERMINAL_STATES.has(newStatus)) {
          stop();
        }
      } catch {
        // error-policy:J4 A failed status poll clears loading and retries until
        // the explicit error limit, while superseded requests stay invisible.
        if (isCurrentEffect() && generation === requestGeneration) {
          consecutiveErrors++;
          setResult((prev) => ({ ...prev, isLoading: false }));
          if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
            stop();
          }
        }
      } finally {
        timeoutSignal.removeEventListener("abort", abortForTimeout);
        if (requestController === controller) requestController = null;
      }
    };

    void poll();

    interval = setInterval(() => void poll(), intervalMs);

    return stop;
  }, [agentId, enabled, intervalMs]);

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
