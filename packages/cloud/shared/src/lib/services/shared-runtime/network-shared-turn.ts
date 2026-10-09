/**
 * Prepares opt-in Network self-context for the account's existing Personal
 * Shared conversation. It changes no agent, room, phone, or history identity.
 */

import { ElizaError } from "@elizaos/core/protocol";
import type { AppContext, Bindings } from "../../../types/cloud-worker-env";
import { ApiError } from "../../api/cloud-worker-errors";
import { isNetworkAppId, NetworkMembershipClient } from "./network-membership-client";
import type { NetworkSharedTurnObservation } from "./network-shared-context";
import { isCanonicalPersonalSharedAgent } from "./personal-shared-identity";
import type { SharedRuntimeAgent } from "./shared-runtime-agent";

/** Web requests retain the existing user authentication owner before the shared account projection. */
export async function prepareNetworkSharedTurn(
  c: AppContext,
  agent: SharedRuntimeAgent,
  requestedApp: unknown,
  message: string,
): Promise<NetworkSharedTurnObservation | undefined> {
  if (c.env.NETWORK_SHARED_ENABLED !== "true" && requestedApp === undefined) return undefined;
  if (!isCanonicalPersonalSharedAgent(agent) && requestedApp === undefined) return undefined;
  const { requireUserOrApiKeyWithOrg } = await import("../../auth/workers-hono-auth");
  const authenticatedUser = await requireUserOrApiKeyWithOrg(c);
  return await prepareNetworkSharedTurnForAccount(
    c.env,
    agent,
    {
      userId: authenticatedUser.id,
      organizationId: authenticatedUser.organization_id,
    },
    requestedApp,
    message,
    c.req.raw.signal,
  );
}

/**
 * Reuses the primary verified-phone projection after the caller's existing
 * session or internal delivery owner has authenticated these exact account IDs.
 * Raw phone input alone is never an authentication authority.
 */
export async function prepareNetworkSharedTurnForAccount(
  bindings: Pick<
    Bindings,
    "NETWORK_SHARED_ENABLED" | "NETWORK_MEMBERSHIP" | "NETWORK_MEMBERSHIP_SERVER_TOKEN"
  >,
  agent: SharedRuntimeAgent,
  trustedAccount: { userId: string; organizationId: string; phoneNumber?: string },
  requestedApp: unknown,
  message: string,
  signal?: AbortSignal,
): Promise<NetworkSharedTurnObservation | undefined> {
  signal?.throwIfAborted();
  if (bindings.NETWORK_SHARED_ENABLED !== "true" && requestedApp === undefined) return undefined;
  if (requestedApp !== undefined && !isNetworkAppId(requestedApp)) {
    throw new ApiError({
      status: 400,
      code: "validation_error",
      message: "Network app selection is invalid",
    });
  }
  if (!message.trim()) {
    if (requestedApp === undefined) return undefined;
    throw new ApiError({
      status: 400,
      code: "validation_error",
      message: "Network context requires a user message",
    });
  }
  if (
    !isCanonicalPersonalSharedAgent(agent) ||
    agent.user_id !== trustedAccount.userId ||
    agent.organization_id !== trustedAccount.organizationId
  ) {
    throw new ApiError({
      status: 403,
      code: "access_denied",
      message: "Network context requires your existing personal Eliza conversation",
    });
  }
  const unavailable = (
    reason:
      | "configuration_unavailable"
      | "verified_phone_required"
      | "private_service_unavailable"
      | "membership_unavailable",
  ): NetworkSharedTurnObservation => ({
    status: "unavailable",
    cloudUserId: agent.user_id,
    organizationId: agent.organization_id,
    reason,
  });
  if (
    bindings.NETWORK_SHARED_ENABLED !== "true" ||
    !bindings.NETWORK_MEMBERSHIP ||
    !bindings.NETWORK_MEMBERSHIP_SERVER_TOKEN
  )
    return unavailable("configuration_unavailable");
  const { readActiveVerifiedPhoneAccount } = await import("../../auth/verified-phone-account");
  const verified = await readActiveVerifiedPhoneAccount(trustedAccount);
  signal?.throwIfAborted();
  if (!verified) return unavailable("verified_phone_required");
  const authenticatedUser = {
    id: verified.user.id,
    organization_id: verified.organization.id,
    organization: { id: verified.organization.id, is_active: verified.organization.is_active },
    is_active: verified.user.is_active,
    is_anonymous: verified.user.is_anonymous,
  };
  const account = { authenticatedUser, ...verified };
  try {
    const client = new NetworkMembershipClient(
      bindings.NETWORK_MEMBERSHIP,
      bindings.NETWORK_MEMBERSHIP_SERVER_TOKEN,
    );
    const membership = await client.resolveForText(account, message, signal);
    if (!membership) return undefined;
    if (requestedApp !== undefined && requestedApp !== membership.app) {
      throw new ApiError({
        status: 409,
        code: "validation_error",
        message: "Requested Network app does not match Network's routing decision",
      });
    }
    const context = await client.resolveContext(account, membership, signal);
    if (!context) return unavailable("membership_unavailable");
    return { membership, context };
  } catch (error) {
    // error-policy:J4 known private read failures are explicit Network observations; the existing Personal host retains its own authority.
    if (error instanceof ElizaError)
      return unavailable(
        error.code === "NETWORK_MEMBERSHIP_ACCOUNT_INVALID"
          ? "verified_phone_required"
          : "private_service_unavailable",
      );
    throw error;
  }
}
