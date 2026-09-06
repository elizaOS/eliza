/** Defines image cutover results, health payloads, and canary transaction callbacks used during upgrade and rollback. */
import type { DbTransaction } from "../../../../db/client";

export type AgentRuntimeStartupPayload = {
  phase?: unknown;
  attempt?: unknown;
  lastError?: unknown;
};

export type AgentRuntimeStatusPayload = {
  state?: unknown;
  canRespond?: unknown;
  startup?: AgentRuntimeStartupPayload | null;
};

export type AgentRuntimeHealthPayload = {
  ready?: unknown;
  canRespond?: unknown;
  runtime?: unknown;
  database?: unknown;
  databaseLiveness?: {
    status?: unknown;
    ok?: unknown;
    terminal?: unknown;
    message?: unknown;
  } | null;
  plugins?: { loaded?: unknown; failed?: unknown } | null;
  agentState?: unknown;
  startup?: AgentRuntimeStartupPayload | null;
};

export const UPGRADE_RUNTIME_HEALTH_GATE_TIMEOUT_MS = 30_000;

export interface AdminCanaryImageExecutionPolicy {
  operation: "upgrade" | "rollback";
  targetOwnerUserId: string;
  sourceImage: string;
  sourceDigest: string;
  targetImage: string;
  targetDigest: string;
  onCutoverInTx: (
    tx: DbTransaction,
    result: {
      oldNodeId: string;
      oldContainerName: string;
      newNodeId: string;
      newContainerName: string;
      newDigest: string;
    },
  ) => Promise<void>;
  onConvergedInTx: (tx: DbTransaction) => Promise<void>;
}

export interface ImageSwapResult {
  success: boolean;
  oldNodeId?: string;
  oldContainerName?: string;
  newNodeId?: string;
  newContainerName?: string;
  newDigest?: string | null;
  error?: string;
  /**
   * True when a failed upgrade left the old container serving. The permanent
   * failure writeback must not mark such a sandbox terminal because the proxy
   * and orphan reconciler treat terminal rows as unavailable. Every blue
   * provision, health, digest, runtime, snapshot, and swap failure occurs
   * before cutover and tears down only blue; `false` is reserved for an agent
   * whose old container was already not serving.
   */
  rolledBack?: boolean;
  /**
   * The image cutover committed, but the replaced container's durable cleanup
   * fence remains populated. Callers must not present the operation as fully
   * converged until the replacement-cleanup reconciler clears it.
   */
  cleanupPending?: boolean;
}

export function digestPinnedImageRef(imageRef: string, digest: string): string {
  if (imageRef.includes("@sha256:")) return imageRef;
  const lastColon = imageRef.lastIndexOf(":");
  const lastSlash = imageRef.lastIndexOf("/");
  const withoutTag = lastColon > lastSlash ? imageRef.slice(0, lastColon) : imageRef;
  return `${withoutTag}@${digest}`;
}
