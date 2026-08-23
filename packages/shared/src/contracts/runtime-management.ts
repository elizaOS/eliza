/** Cross-process contract for owner-approved Devices & Runtimes operations. */

export const RUNTIME_MANAGEMENT_OPERATIONS = [
  "list",
  "pair",
  "revoke",
  "remove",
  "retry",
  "inspect_ssh",
  "connect_ssh",
  "add_direct",
  "enroll_host",
  "approve_pairing",
  "start_host",
  "stop_host",
  "revoke_host",
] as const;

export type RuntimeManagementOperation =
  (typeof RUNTIME_MANAGEMENT_OPERATIONS)[number];

export interface RuntimeManagementRequest {
  op: RuntimeManagementOperation;
  targetId?: string;
  runtimeId?: string;
  label?: string;
  target?: string;
  sshPort?: number;
  remoteApiPort?: number;
  expectedFingerprint?: string;
  identityFile?: string;
  apiBase?: string;
  sessionId?: string;
  code?: string;
  /** One-use server proposal authority for an exact destructive request. */
  proposalId?: string;
  proposalNonce?: string;
  managedNetwork?: boolean;
}

export interface RuntimeManagementResult {
  ok: boolean;
  op: RuntimeManagementOperation;
  data?: Record<string, unknown>;
  error?: string;
}

export function isRuntimeManagementOperation(
  value: unknown,
): value is RuntimeManagementOperation {
  return (
    typeof value === "string" &&
    (RUNTIME_MANAGEMENT_OPERATIONS as readonly string[]).includes(value)
  );
}
