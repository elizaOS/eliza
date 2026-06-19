/**
 * Approvals-domain data layer: typed list queries + action mutations against the
 * real Cloud backend.
 *
 * Endpoints (all same-origin via the shared cloud `api<T>` client):
 *  - GET  /api/v1/approval-requests            owner list (Bearer-gated)
 *  - POST /api/v1/approval-requests/:id/approve  signer-facing (signature)
 *  - POST /api/v1/approval-requests/:id/deny     signer-facing (reason)
 *  - GET  /api/v1/ballots                       owner list (Bearer-gated)
 *  - POST /api/v1/ballots/:id/vote               participant (scoped token)
 *  - POST /api/v1/ballots/:id/tally              owner (tally if threshold met)
 *  - POST /api/v1/ballots/:id/cancel             owner
 *  - GET  /api/v1/sensitive-requests/:id         owner detail (Bearer-gated)
 *  - POST /api/v1/sensitive-requests/:id/cancel  owner
 *
 * NOTE (sensitive-requests): the backend exposes only POST-create + per-id GET +
 * cancel. There is **no owner list/collection endpoint**, so the Sensitive tab
 * is a per-id lookup (owner pastes / arrives with a request id) rather than a
 * list. Secret submission for these stays on the public token page / the inline
 * chat block; the owner action here is cancel. Adding a list endpoint is backend
 * work (out of this agent's scope) — flagged as a follow-up.
 *
 * Dates are serialized as ISO strings over the wire (DB `Date` → JSON string),
 * so every timestamp field below is typed `string`.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../lib/api-client";
import { authenticatedQueryKey, useAuthenticatedQueryGate } from "./auth-query";

// ── Approval requests ──────────────────────────────────────────────────────

export type ApprovalChallengeKind = "login" | "signature" | "generic";
export type ApprovalSignerKind = "wallet" | "ed25519";
export type ApprovalRequestStatus =
  | "pending"
  | "delivered"
  | "approved"
  | "denied"
  | "expired"
  | "canceled";

export interface ApprovalChallengePayload {
  message: string;
  signerKind?: ApprovalSignerKind;
  walletAddress?: string;
  publicKey?: string;
  context?: Record<string, unknown>;
}

/** Owner view of an approval request (`GET /api/v1/approval-requests`). */
export interface ApprovalRequest {
  id: string;
  organizationId: string;
  agentId: string | null;
  userId: string | null;
  challengeKind: ApprovalChallengeKind;
  challengePayload: ApprovalChallengePayload;
  expectedSignerIdentityId: string | null;
  status: ApprovalRequestStatus;
  signatureText: string | null;
  signedAt: string | null;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
  metadata: Record<string, unknown>;
}

interface ApprovalListResponse {
  success: boolean;
  approvalRequests: ApprovalRequest[];
}

interface ApprovalActionResponse {
  success: boolean;
  approvalRequest: ApprovalRequest;
  signerIdentityId?: string;
}

const APPROVALS_KEY = ["cloud", "approval-requests"] as const;

/**
 * `GET /api/v1/approval-requests` — the owner's approval requests. Defaults to
 * the pending/awaiting buckets; pass `status` to filter server-side.
 */
export function useApprovalRequests(filter?: {
  status?: ApprovalRequestStatus;
}) {
  const gate = useAuthenticatedQueryGate();
  const status = filter?.status;
  return useQuery({
    queryKey: authenticatedQueryKey([...APPROVALS_KEY, { status }], gate),
    queryFn: async () => {
      const query = status ? `?status=${encodeURIComponent(status)}` : "";
      const data = await api<ApprovalListResponse>(
        `/api/v1/approval-requests${query}`,
      );
      return data.approvalRequests;
    },
    enabled: gate.enabled,
  });
}

/** Approve an approval request with a wallet/ed25519 signature. */
export function useApproveRequest() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { id: string; signature: string }) => {
      const data = await api<ApprovalActionResponse>(
        `/api/v1/approval-requests/${encodeURIComponent(input.id)}/approve`,
        { method: "POST", json: { signature: input.signature } },
      );
      return data.approvalRequest;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: APPROVALS_KEY });
    },
  });
}

/** Deny an approval request (no signature required). */
export function useDenyRequest() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { id: string; reason?: string }) => {
      const data = await api<ApprovalActionResponse>(
        `/api/v1/approval-requests/${encodeURIComponent(input.id)}/deny`,
        {
          method: "POST",
          json: { reason: input.reason ?? "denied by owner" },
        },
      );
      return data.approvalRequest;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: APPROVALS_KEY });
    },
  });
}

// ── Ballots ────────────────────────────────────────────────────────────────

export type BallotStatus = "open" | "tallied" | "expired" | "canceled";

export interface BallotParticipant {
  identityId: string;
  label?: string;
  channelHint?: string;
}

export interface BallotTallyResult {
  threshold: number;
  totalVotes: number;
  values: string[];
  counts: Record<string, number>;
}

/** Owner view of a secret ballot (`GET /api/v1/ballots`). */
export interface Ballot {
  id: string;
  organizationId: string;
  agentId: string | null;
  purpose: string;
  participants: BallotParticipant[];
  threshold: number;
  status: BallotStatus;
  tallyResult: BallotTallyResult | null;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
  metadata: Record<string, unknown>;
}

interface BallotListResponse {
  success: boolean;
  ballots: Ballot[];
}

interface BallotResponse {
  success: boolean;
  ballot: Ballot;
}

interface BallotVoteResponse {
  success: boolean;
  outcome?: "recorded" | "replay_same_value";
  ballotStatus?: BallotStatus;
  error?: string;
}

interface BallotTallyResponse {
  success: boolean;
  tallied: boolean;
  ballot: Ballot;
  tallyResult: BallotTallyResult | null;
}

const BALLOTS_KEY = ["cloud", "ballots"] as const;

/** `GET /api/v1/ballots` — the owner's secret ballots. */
export function useBallots(filter?: { status?: BallotStatus }) {
  const gate = useAuthenticatedQueryGate();
  const status = filter?.status;
  return useQuery({
    queryKey: authenticatedQueryKey([...BALLOTS_KEY, { status }], gate),
    queryFn: async () => {
      const query = status ? `?status=${encodeURIComponent(status)}` : "";
      const data = await api<BallotListResponse>(`/api/v1/ballots${query}`);
      return data.ballots;
    },
    enabled: gate.enabled,
  });
}

/**
 * Cast a vote on a ballot with a participant scoped token. The owner can vote
 * here when they hold a scoped token (participant in their own ballot); the
 * server gates on the token hash, not the session.
 */
export function useVoteBallot() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      id: string;
      scopedToken: string;
      value: string;
    }) => {
      const data = await api<BallotVoteResponse>(
        `/api/v1/ballots/${encodeURIComponent(input.id)}/vote`,
        {
          method: "POST",
          json: { scopedToken: input.scopedToken, value: input.value },
        },
      );
      if (!data.success) {
        throw new Error(data.error ?? "Unable to record vote.");
      }
      return data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: BALLOTS_KEY });
    },
  });
}

/** Tally a ballot if its threshold has been met (owner). */
export function useTallyBallot() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { id: string }) => {
      const data = await api<BallotTallyResponse>(
        `/api/v1/ballots/${encodeURIComponent(input.id)}/tally`,
        { method: "POST", json: {} },
      );
      return data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: BALLOTS_KEY });
    },
  });
}

/** Cancel a ballot (owner). */
export function useCancelBallot() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { id: string; reason?: string }) => {
      const data = await api<BallotResponse>(
        `/api/v1/ballots/${encodeURIComponent(input.id)}/cancel`,
        { method: "POST", json: { reason: input.reason } },
      );
      return data.ballot;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: BALLOTS_KEY });
    },
  });
}

// ── Sensitive requests (per-id lookup; no owner collection endpoint) ─────────

export type SensitiveRequestStatus =
  | "pending"
  | "fulfilled"
  | "failed"
  | "canceled"
  | "expired";
export type SensitiveRequestKind =
  | "secret"
  | "private_info"
  | "payment"
  | "oauth";

/** Owner detail view of a sensitive request (`GET /api/v1/sensitive-requests/:id`). */
export interface SensitiveRequest {
  id: string;
  kind: SensitiveRequestKind;
  status: SensitiveRequestStatus;
  reason?: string | null;
  agentId?: string | null;
  expiresAt?: string | null;
  createdAt?: string | null;
  target?: {
    kind?: SensitiveRequestKind;
    key?: string;
    fields?: Array<{ name: string; label?: string; required?: boolean }>;
  };
}

type SensitiveRequestLoad = SensitiveRequest | { request: SensitiveRequest };

interface SensitiveRequestCancelResponse {
  success: boolean;
  request: SensitiveRequest;
}

function normalizeSensitiveRequest(
  payload: SensitiveRequestLoad,
): SensitiveRequest {
  return "request" in payload ? payload.request : payload;
}

const SENSITIVE_KEY = ["cloud", "sensitive-requests"] as const;

/**
 * `GET /api/v1/sensitive-requests/:id` — owner detail (no token; Bearer-gated).
 * Enabled only when `id` is a non-empty string.
 */
export function useSensitiveRequest(id: string | null) {
  const gate = useAuthenticatedQueryGate();
  const trimmed = id?.trim() ?? "";
  return useQuery({
    queryKey: authenticatedQueryKey([...SENSITIVE_KEY, trimmed], gate),
    queryFn: async () => {
      const data = await api<SensitiveRequestLoad>(
        `/api/v1/sensitive-requests/${encodeURIComponent(trimmed)}`,
      );
      return normalizeSensitiveRequest(data);
    },
    enabled: gate.enabled && trimmed.length > 0,
  });
}

/** Cancel a sensitive request (owner). */
export function useCancelSensitiveRequest() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { id: string }) => {
      const data = await api<SensitiveRequestCancelResponse>(
        `/api/v1/sensitive-requests/${encodeURIComponent(input.id)}/cancel`,
        { method: "POST", json: {} },
      );
      return data.request;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: SENSITIVE_KEY });
    },
  });
}

// ── Shared formatting ────────────────────────────────────────────────────────

export function formatApprovalTimestamp(value: string | null): string | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return null;
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(parsed));
}
