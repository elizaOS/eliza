/** Derives and verifies the account-native identity that grants Personal Shared USER authority. */

import { v5 as uuidv5 } from "uuid";
import type { SharedRuntimeAgent } from "./shared-runtime-agent";

const PERSONAL_SHARED_AGENT_NAMESPACE = "af8f7624-42f8-4da8-bdf1-593b1a0d7f20";
const PERSONAL_SHARED_AGENT_PREFIX = "personal:";

/**
 * Server-owned projects that may enable additional capabilities on a Personal
 * turn. Project authorization never changes the account's assistant or room.
 */
const PROJECT_SCOPED_PERSONAL_SHARED_PROJECTS: ReadonlySet<string> = new Set(["network"]);

export const NETWORK_PERSONAL_SHARED_PROJECT = "network";

export interface PersonalSharedAccountIdentity {
  userId: string;
  organizationId: string;
  /**
   * Server-resolved product project for turn capabilities. Never changes identity.
   */
  project?: string;
}

/** Authorized product marker, independent of the account identity. */
export function personalSharedProjectScope(project: string | undefined | null): string | undefined {
  const normalized = project?.trim().toLowerCase();
  return normalized && PROJECT_SCOPED_PERSONAL_SHARED_PROJECTS.has(normalized)
    ? normalized
    : undefined;
}

/** Stable namespaced id used for Durable Object routing and mirrored history. */
export function personalSharedAgentId(identity: PersonalSharedAccountIdentity): string {
  const account = `${identity.organizationId.trim()}:${identity.userId.trim()}`;
  return `${PERSONAL_SHARED_AGENT_PREFIX}${uuidv5(account, PERSONAL_SHARED_AGENT_NAMESPACE)}`;
}

/** Inventory only: the former Network address. Never use for new turns or alias automatically. */
export function legacyNetworkPersonalSharedAgentId(
  identity: PersonalSharedAccountIdentity,
): string {
  const account = `${identity.organizationId.trim()}:${identity.userId.trim()}`;
  return `${PERSONAL_SHARED_AGENT_PREFIX}${uuidv5(`network:${account}`, PERSONAL_SHARED_AGENT_NAMESPACE)}`;
}

/** True only for the namespace reserved for rowless account-native identities. */
export function isPersonalSharedAgentId(value: string): boolean {
  return /^personal:[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
}

/** Exact account-derived identity required before a Shared turn receives USER authority. */
export function isCanonicalPersonalSharedAgent(
  agent: Pick<SharedRuntimeAgent, "id" | "organization_id" | "user_id" | "execution_tier"> & {
    project?: string;
  },
): boolean {
  return (
    agent.execution_tier === "shared" &&
    agent.id ===
      personalSharedAgentId({
        userId: agent.user_id,
        organizationId: agent.organization_id,
        project: agent.project,
      })
  );
}
