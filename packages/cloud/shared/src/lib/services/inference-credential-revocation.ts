/**
 * Strongly consistent credential and subject revocation for inference.
 *
 * Cloudflare KV remains a projection only. When enabled, every positive
 * inference authorization crosses the organization Durable Object before it
 * can reach a provider, while lifecycle mutations commit their denial fence
 * to that same object before reporting success.
 */

import { ElizaError } from "@elizaos/core";
import type {
  RuntimeDurableObjectNamespace,
  RuntimeDurableObjectStub,
} from "../../types/cloud-worker-env";
import { getCloudAwareEnv, getCloudBinding } from "../runtime/cloud-bindings";
import type { InferenceAuthRejectionReason } from "./inference-auth-cache";

const GATE_BINDING = "INFERENCE_ADMISSION_GATES";
const GATE_ORIGIN = "https://inference-admission.internal";
const OPERATION_TIMEOUT_MS = 1_500;

export type InferenceCredentialCheck =
  | { kind: "api_key"; credentialId: string; userId: string }
  | { kind: "steward_session"; userId: string; stewardUserId: string; issuedAt: number };

export type InferenceSubjectDisableReason = "account" | "moderation" | "membership";

interface RevocationResponse {
  allowed?: boolean;
  committed?: boolean;
  reason?: string;
}

export class InferenceCredentialRevocationUnavailableError extends ElizaError {
  override readonly name = "InferenceCredentialRevocationUnavailableError";
  readonly statusCode = 503;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, {
      code: "INFERENCE_CREDENTIAL_REVOCATION_UNAVAILABLE",
      cause: options?.cause,
      severity: "ephemeral",
    });
  }
}

export class InferenceCredentialRevokedError extends ElizaError {
  override readonly name = "InferenceCredentialRevokedError";

  constructor(readonly reason: string) {
    super("Inference credential is revoked", {
      code: "INFERENCE_CREDENTIAL_REVOKED",
      context: { reason },
    });
  }
}

/** Map the strong-boundary reason onto the bounded public standing taxonomy. */
export function inferenceCredentialRevocationReason(reason: string): InferenceAuthRejectionReason {
  switch (reason) {
    case "organization_disabled":
      return "organization_inactive";
    case "subject_account_disabled":
      return "account_inactive";
    case "subject_membership_disabled":
      return "membership_missing";
    case "subject_moderation_disabled":
      return "moderation_blocked";
    case "credential_revoked":
    case "session_revoked":
    case "session_binding_revoked":
      return "credential_inactive";
    default:
      return "credential_invalid";
  }
}

/** The revocation boundary is independently default-off for staged rollout. */
export function isInferenceStrongRevocationEnabled(
  env: Record<string, unknown> = getCloudAwareEnv(),
): boolean {
  return env.INFERENCE_STRONG_REVOCATION_ENABLED === "true";
}

/** Only fixed type labels and native boolean flags may enter the indexed log message. */
function describeBoundaryCause(error: unknown): string {
  const causeType =
    error instanceof TypeError
      ? "TypeError"
      : error instanceof DOMException && error.name === "AbortError"
        ? "AbortError"
        : error instanceof DOMException && error.name === "TimeoutError"
          ? "TimeoutError"
          : error instanceof Error
            ? "Error"
            : "unclassified";
  const parts = [`causeType=${causeType}`];
  if (error instanceof Error) {
    for (const flag of ["retryable", "overloaded", "remote"]) {
      // Inspect data properties so an exception's custom getters cannot break diagnostics.
      const descriptor = Object.getOwnPropertyDescriptor(error, flag);
      if (descriptor && typeof descriptor.value === "boolean") {
        parts.push(`${flag}=${descriptor.value}`);
      }
    }
  }
  return parts.join(" ");
}

function gateStub(organizationId: string): RuntimeDurableObjectStub {
  const namespace = getCloudBinding<RuntimeDurableObjectNamespace>(GATE_BINDING);
  if (!namespace) {
    throw new InferenceCredentialRevocationUnavailableError(
      "Inference revocation Durable Object binding is missing",
    );
  }
  try {
    return namespace.getByName(organizationId);
  } catch (error) {
    // error-policy:J2 preserve lookup failures separately from requests to the object.
    throw new InferenceCredentialRevocationUnavailableError(
      `Inference revocation Durable Object lookup failed ${describeBoundaryCause(error)}`,
      { cause: error },
    );
  }
}

async function gateRequest(
  organizationId: string,
  path: string,
  body: Record<string, unknown>,
  allowExplicitDenial = false,
): Promise<RevocationResponse> {
  const stub = gateStub(organizationId);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), OPERATION_TIMEOUT_MS);
  let response: Response;
  try {
    response = await stub.fetch(
      new Request(`${GATE_ORIGIN}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ organizationId, ...body }),
        signal: controller.signal,
      }),
    );
  } catch (error) {
    // error-policy:J2 transport failure must stay fail-closed with its cause.
    throw new InferenceCredentialRevocationUnavailableError(
      `Inference revocation boundary is unavailable deadlineExceeded=${controller.signal.aborted} ${describeBoundaryCause(error)}`,
      { cause: error },
    );
  } finally {
    clearTimeout(timeout);
  }

  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch (error) {
    // error-policy:J3 malformed boundary output is never authorization.
    throw new InferenceCredentialRevocationUnavailableError(
      "Inference revocation boundary returned invalid JSON",
      { cause: error },
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new InferenceCredentialRevocationUnavailableError(
      "Inference revocation boundary returned an invalid response",
    );
  }
  const result = parsed as RevocationResponse;
  const explicitDenial =
    allowExplicitDenial &&
    response.status === 403 &&
    result.allowed === false &&
    typeof result.reason === "string";
  if (!response.ok && !explicitDenial) {
    throw new InferenceCredentialRevocationUnavailableError(
      `Inference revocation boundary failed with status ${response.status}`,
    );
  }
  return result;
}

/** Fail closed unless the strong boundary confirms this credential is active. */
export async function assertInferenceCredentialActive(
  organizationId: string,
  credential: InferenceCredentialCheck,
): Promise<void> {
  if (!isInferenceStrongRevocationEnabled()) return;
  const result = await gateRequest(organizationId, "/credential/check", credential, true);
  if (result.allowed !== true) {
    throw new InferenceCredentialRevokedError(result.reason ?? "revoked");
  }
}

async function commitMutation(
  organizationId: string,
  path: string,
  body: Record<string, unknown>,
): Promise<void> {
  if (!isInferenceStrongRevocationEnabled()) return;
  const result = await gateRequest(organizationId, path, body);
  if (result.committed !== true) {
    throw new InferenceCredentialRevocationUnavailableError(
      "Inference revocation boundary did not confirm the mutation",
    );
  }
}

/** Permanently revoke one immutable API-key row identity. */
export async function revokeInferenceApiKey(
  organizationId: string,
  apiKeyId: string,
): Promise<void> {
  await commitMutation(organizationId, "/credential/revoke", {
    kind: "api_key",
    credentialId: apiKeyId,
  });
}

/** Disable or re-enable every credential belonging to a Cloud user in one org. */
export async function setInferenceSubjectActive(
  organizationId: string,
  userId: string,
  active: boolean,
  reason: InferenceSubjectDisableReason,
): Promise<void> {
  await commitMutation(organizationId, "/subject/set-active", { userId, active, reason });
}

/** Revoke Steward sessions issued at or before the supplied immutable iat. */
export async function revokeInferenceSessionsThrough(
  organizationId: string,
  userId: string,
  issuedAt: number,
): Promise<void> {
  await commitMutation(organizationId, "/session/revoke-through", { userId, issuedAt });
}

/** Disable or re-enable one Steward-subject to Cloud-user identity binding. */
export async function setInferenceSessionBindingActive(
  organizationId: string,
  userId: string,
  stewardUserId: string,
  active: boolean,
): Promise<void> {
  await commitMutation(organizationId, "/session/set-binding-active", {
    userId,
    stewardUserId,
    active,
  });
}

/** Disable or re-enable every inference credential in an organization. */
export async function setInferenceOrganizationActive(
  organizationId: string,
  active: boolean,
): Promise<void> {
  await commitMutation(organizationId, "/organization/set-active", { active });
}
