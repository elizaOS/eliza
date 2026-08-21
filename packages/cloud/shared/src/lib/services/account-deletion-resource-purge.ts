/** Permanently removes personal-organization resources before the account row is deleted. */

import { agentSandboxesRepository } from "../../db/repositories/agent-sandboxes";
import { organizationsRepository } from "../../db/repositories/organizations";
import { userVoicesRepository } from "../../db/repositories/user-voices";
import type { RuntimeR2Bucket } from "../storage/r2-runtime-binding";
import { getStripe } from "../stripe";
import { logger } from "../utils/logger";
import { deleteAppWithCleanup } from "./app-cleanup";
import { appsService } from "./apps";
import { elizaSandboxService } from "./eliza-sandbox";
import { managedDomainsService } from "./managed-domains";
import { voiceCloningService } from "./voice-cloning";

export interface AccountDeletionResourcePurgeDependencies {
  disableBilling(organizationId: string): Promise<string | null>;
  deleteBillingCustomer(customerId: string): Promise<void>;
  prepareManagedDomains(organizationId: string): Promise<void>;
  listAgentIds(organizationId: string): Promise<string[]>;
  deleteAgent(agentId: string, organizationId: string): Promise<void>;
  listAppIds(organizationId: string): Promise<string[]>;
  deleteApp(appId: string): Promise<void>;
  listActiveVoiceIds(organizationId: string): Promise<string[]>;
  deleteVoice(voiceId: string, organizationId: string): Promise<void>;
  purgeObjectStorage(bucket: RuntimeR2Bucket, organizationId: string): Promise<number>;
}

function isMissingStripeResource(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { code?: unknown; statusCode?: unknown };
  return candidate.code === "resource_missing" || candidate.statusCode === 404;
}

function objectBelongsToOrganization(
  key: string,
  customMetadata: Record<string, string> | undefined,
  organizationId: string,
): boolean {
  if (customMetadata?.organizationId === organizationId) return true;
  return key.split("/").includes(organizationId);
}

export async function purgeOrganizationObjectStorage(
  bucket: RuntimeR2Bucket,
  organizationId: string,
): Promise<number> {
  if (!bucket.list) {
    throw new Error("R2 binding does not support listing for account deletion");
  }

  let cursor: string | undefined;
  let truncated = true;
  const keysToDelete: string[] = [];
  const seenCursors = new Set<string>();
  while (truncated) {
    const page = await bucket.list({ cursor, include: ["customMetadata"], limit: 1_000 });
    const keys = page.objects
      .filter((object) =>
        object.key
          ? objectBelongsToOrganization(object.key, object.customMetadata, organizationId)
          : false,
      )
      .map((object) => object.key as string);
    keysToDelete.push(...keys);

    truncated = page.truncated;
    if (!truncated) break;
    if (!page.cursor || seenCursors.has(page.cursor)) {
      throw new Error("R2 account-deletion listing returned an invalid cursor");
    }
    seenCursors.add(page.cursor);
    cursor = page.cursor;
  }

  for (let index = 0; index < keysToDelete.length; index += 100) {
    await Promise.all(keysToDelete.slice(index, index + 100).map((key) => bucket.delete(key)));
  }
  return keysToDelete.length;
}

export function defaultAccountDeletionResourcePurgeDependencies(): AccountDeletionResourcePurgeDependencies {
  return {
    async disableBilling(organizationId) {
      const organization = await organizationsRepository.findById(organizationId);
      if (!organization) return null;
      await organizationsRepository.update(organizationId, {
        auto_top_up_enabled: false,
        is_active: false,
      });
      return organization.stripe_customer_id;
    },
    async deleteBillingCustomer(customerId) {
      try {
        await getStripe().customers.del(customerId);
      } catch (error) {
        if (!isMissingStripeResource(error)) throw error;
      }
    },
    async prepareManagedDomains(organizationId) {
      const domains = await managedDomainsService.listForOrganization(organizationId);
      const registered = domains.filter((domain) => domain.registrar === "cloudflare");
      await Promise.all(
        registered
          .filter((domain) => domain.autoRenew)
          .map((domain) => managedDomainsService.setAutoRenew(domain.id, false)),
      );
      if (registered.length > 0) {
        throw new Error(
          "Registered domains must be transferred or released before account deletion can complete",
        );
      }
    },
    async listAgentIds(organizationId) {
      return (await agentSandboxesRepository.listByOrganization(organizationId)).map(
        (agent) => agent.id,
      );
    },
    async deleteAgent(agentId, organizationId) {
      const result = await elizaSandboxService.deleteAgent(agentId, organizationId, {
        authorization: "account_deletion",
      });
      if (!result.success) {
        throw new Error(result.error || `Agent ${agentId} could not be deleted`);
      }
    },
    async listAppIds(organizationId) {
      return (await appsService.listByOrganization(organizationId)).map((app) => app.id);
    },
    async deleteApp(appId) {
      const result = await deleteAppWithCleanup(appId, {
        continueOnError: false,
        deleteGitHubRepo: true,
        requireContainerTeardownCompletion: true,
      });
      if (!result.success) throw new Error(result.errors.join("; "));
    },
    async listActiveVoiceIds(organizationId) {
      const ids: string[] = [];
      let offset = 0;
      let hasMore = true;
      while (hasMore) {
        const result = await userVoicesRepository.listByOrganization(organizationId, {
          includeInactive: false,
          limit: 100,
          offset,
        });
        ids.push(...result.voices.map((voice) => voice.id));
        hasMore = result.hasMore;
        if (!hasMore) return ids;
        offset += result.voices.length;
        if (result.voices.length === 0) {
          throw new Error("Voice deletion pagination did not advance");
        }
      }
      return ids;
    },
    deleteVoice: (voiceId, organizationId) =>
      voiceCloningService.deleteVoice(voiceId, organizationId),
    purgeObjectStorage: purgeOrganizationObjectStorage,
  };
}

export async function purgePersonalOrganizationResources(input: {
  organizationId: string;
  blob: RuntimeR2Bucket;
  dependencies?: AccountDeletionResourcePurgeDependencies;
}): Promise<void> {
  const dependencies = input.dependencies ?? defaultAccountDeletionResourcePurgeDependencies();
  const customerId = await dependencies.disableBilling(input.organizationId);
  if (customerId) await dependencies.deleteBillingCustomer(customerId);
  await dependencies.prepareManagedDomains(input.organizationId);

  for (const agentId of await dependencies.listAgentIds(input.organizationId)) {
    await dependencies.deleteAgent(agentId, input.organizationId);
  }
  for (const appId of await dependencies.listAppIds(input.organizationId)) {
    await dependencies.deleteApp(appId);
  }
  for (const voiceId of await dependencies.listActiveVoiceIds(input.organizationId)) {
    await dependencies.deleteVoice(voiceId, input.organizationId);
  }
  const deletedObjects = await dependencies.purgeObjectStorage(input.blob, input.organizationId);
  logger.info("[AccountDeletion] Purged organization resources", {
    organizationId: input.organizationId,
    deletedObjects,
  });
}
