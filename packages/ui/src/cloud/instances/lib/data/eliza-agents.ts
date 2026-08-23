/**
 * React-query hooks for the hosted Eliza agents (Instances) list + detail.
 */

import type {
  AgentDatabaseStatus,
  AgentExecutionTier,
  AgentSandboxStatus,
  NormalizedAgentListItemDto,
  NormalizedAgentResponse,
} from "@elizaos/cloud-sdk";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../../lib/api-client";
import {
  authenticatedQueryKey,
  useAuthenticatedQueryGate,
} from "../../../lib/auth-query";

export type AgentListItem = NormalizedAgentListItemDto;

export type PersonalElizaIdentity = {
  id: string;
  displayName: string;
  runtime: "shared" | "dedicated";
};

const AGENT_STATUSES = [
  "pending",
  "provisioning",
  "running",
  "stopped",
  "sleeping",
  "disconnected",
  "error",
  "deletion_pending",
  "deletion_failed",
] as const satisfies readonly AgentSandboxStatus[];

const DATABASE_STATUSES = [
  "none",
  "provisioning",
  "ready",
  "error",
] as const satisfies readonly AgentDatabaseStatus[];

const EXECUTION_TIERS = [
  "shared",
  "dedicated-lazy",
  "dedicated-always",
  "custom",
] as const satisfies readonly AgentExecutionTier[];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isEnumValue<T extends string>(
  values: readonly T[],
  value: unknown,
): value is T {
  return typeof value === "string" && values.some((item) => item === value);
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isIsoDate(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.includes("T") &&
    Number.isFinite(Date.parse(value))
  );
}

function isNullableIsoDate(value: unknown): value is string | null {
  return value === null || isIsoDate(value);
}

function parseActiveJob(
  value: unknown,
): NormalizedAgentListItemDto["activeJob"] {
  if (value === null) return null;
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.type !== "string" ||
    (value.status !== "pending" && value.status !== "in_progress") ||
    !Number.isInteger(value.attempts) ||
    !Number.isInteger(value.maxAttempts) ||
    !isNullableIsoDate(value.estimatedCompletionAt) ||
    !isIsoDate(value.scheduledFor) ||
    !isNullableIsoDate(value.startedAt) ||
    !isIsoDate(value.createdAt) ||
    !isIsoDate(value.updatedAt)
  ) {
    throw new Error("Agents response contained an invalid active job");
  }
  return value as unknown as NonNullable<
    NormalizedAgentListItemDto["activeJob"]
  >;
}

function parseAgentListItem(value: unknown): NormalizedAgentListItemDto {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    value.id.trim().length === 0 ||
    !isNullableString(value.agentName) ||
    !isEnumValue(AGENT_STATUSES, value.status) ||
    !isEnumValue(DATABASE_STATUSES, value.databaseStatus) ||
    !isNullableIsoDate(value.lastBackupAt) ||
    !isNullableIsoDate(value.lastHeartbeatAt) ||
    !isNullableString(value.errorMessage) ||
    !isIsoDate(value.createdAt) ||
    !isIsoDate(value.updatedAt) ||
    !isNullableString(value.token_address) ||
    !isNullableString(value.token_chain) ||
    !isNullableString(value.token_name) ||
    !isNullableString(value.token_ticker) ||
    !isNullableString(value.dockerImage) ||
    !isEnumValue(EXECUTION_TIERS, value.executionTier) ||
    !isNullableString(value.webUiUrl) ||
    !("activeJob" in value)
  ) {
    throw new Error("Agents response contained an invalid agent record");
  }

  return {
    id: value.id,
    agentName: value.agentName,
    status: value.status,
    databaseStatus: value.databaseStatus,
    lastBackupAt: value.lastBackupAt,
    lastHeartbeatAt: value.lastHeartbeatAt,
    errorMessage: value.errorMessage,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    token_address: value.token_address,
    token_chain: value.token_chain,
    token_name: value.token_name,
    token_ticker: value.token_ticker,
    dockerImage: value.dockerImage,
    executionTier: value.executionTier,
    webUiUrl: value.webUiUrl,
    activeJob: parseActiveJob(value.activeJob),
  };
}

/** Validate the untrusted list envelope once for every agents-list consumer. */
export function parseAgentsResponse(
  payload: unknown,
): NormalizedAgentListItemDto[] {
  if (
    !isRecord(payload) ||
    payload.success !== true ||
    !Array.isArray(payload.data)
  ) {
    throw new Error("Agents response did not include a successful data list");
  }
  return payload.data.map(parseAgentListItem);
}

/** GET /api/v1/eliza/agents — list of Eliza agents in the org. */
export function useAgents() {
  const gate = useAuthenticatedQueryGate();
  return useQuery({
    queryKey: authenticatedQueryKey(["agent", "agents"], gate),
    queryFn: async () => {
      const res = await api<unknown>("/api/v1/eliza/agents");
      return parseAgentsResponse(res);
    },
    enabled: gate.enabled,
    refetchInterval: gate.enabled ? 15_000 : false,
    // Keep polling while the tab is backgrounded so the list converges even when
    // hidden. The agents table hides a just-deleted row for a 60s grace before
    // re-checking; if this interval paused while backgrounded, a delete + long
    // background could freeze the list stale and briefly resurrect the deleted
    // row on refocus. Cheap authenticated GET; precedent: payment-waiting-overlay.
    refetchIntervalInBackground: true,
  });
}

/** The rowless account-native Eliza is authoritative even with zero sandbox rows. */
export function usePersonalElizaIdentity() {
  const gate = useAuthenticatedQueryGate();
  return useQuery({
    queryKey: authenticatedQueryKey(["agent", "personal-identity"], gate),
    enabled: gate.enabled,
    queryFn: async () => {
      const response = await api<{
        success?: boolean;
        data?: { identity?: Partial<PersonalElizaIdentity> };
      }>("/api/v1/eliza/personal");
      const identity = response.data?.identity;
      if (
        response.success !== true ||
        typeof identity?.id !== "string" ||
        !identity.id.startsWith("personal:") ||
        typeof identity.displayName !== "string" ||
        (identity.runtime !== "shared" && identity.runtime !== "dedicated")
      ) {
        throw new Error("Personal Eliza response was invalid");
      }
      return identity as PersonalElizaIdentity;
    },
  });
}

/** GET /api/v1/eliza/agents/[agentId] — single agent detail. */
export function useAgent(agentId: string | undefined) {
  const gate = useAuthenticatedQueryGate(Boolean(agentId));
  return useQuery({
    queryKey: authenticatedQueryKey(["agent", "agent", agentId], gate),
    queryFn: async () => {
      const res = await api<NormalizedAgentResponse>(
        `/api/v1/eliza/agents/${agentId}`,
      );
      return res.data;
    },
    enabled: gate.enabled,
  });
}
