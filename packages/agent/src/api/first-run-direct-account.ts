/**
 * Authenticates and atomically adopts first-run paid-provider credentials into
 * the host account pool before onboarding configuration is committed.
 */

import nodeCrypto from "node:crypto";
import {
  type AccountCredentialRecord,
  createRuntimeAccountStoragePolicy,
  deleteAccount,
  saveAccount,
} from "@elizaos/auth/account-storage";
import { probeDirectApiKey } from "@elizaos/auth/direct-api-probe";
import { ElizaError, resolveStateDir } from "@elizaos/core";
import type { LinkedAccountConfig } from "@elizaos/shared";
import { getAgentHostBridge } from "../runtime/host-bridge.ts";

interface FirstRunAccountPool {
  list(providerId?: string): LinkedAccountConfig[];
  upsert(account: LinkedAccountConfig): Promise<void>;
  deleteMetadata(providerId: string, accountId: string): Promise<void>;
}

export interface FirstRunDirectAccountAdoption {
  account: LinkedAccountConfig;
  rollback(): Promise<void>;
}

/** Prove and store one OpenRouter/xAI credential without writing raw config. */
export async function adoptFirstRunDirectAccount(input: {
  providerId: "openrouter-api" | "xai-api";
  apiKey: string;
}): Promise<FirstRunDirectAccountAdoption> {
  const probe = await probeDirectApiKey(input.providerId, input.apiKey);
  if (!probe.ok) {
    throw new ElizaError(
      probe.error ?? "Credential could not be verified against its provider",
      {
        code: "FIRST_RUN_DIRECT_CREDENTIAL_INVALID",
        context: { providerId: input.providerId, status: probe.status },
        severity: "fatal",
      },
    );
  }

  const pool =
    getAgentHostBridge().getDefaultAccountPool() as FirstRunAccountPool | null;
  if (!pool) {
    throw new ElizaError("Account service is not ready", {
      code: "FIRST_RUN_ACCOUNT_SERVICE_UNAVAILABLE",
      context: { providerId: input.providerId },
      severity: "ephemeral",
    });
  }

  const storagePolicy = createRuntimeAccountStoragePolicy(resolveStateDir());
  const id = nodeCrypto.randomUUID();
  const now = Date.now();
  const record: AccountCredentialRecord = {
    id,
    providerId: input.providerId,
    label: input.providerId === "openrouter-api" ? "OpenRouter" : "xAI",
    source: "api-key",
    credentials: {
      access: input.apiKey,
      refresh: "",
      expires: Number.MAX_SAFE_INTEGER,
    },
    createdAt: now,
    updatedAt: now,
  };
  const nextPriority =
    pool
      .list(input.providerId)
      .reduce((highest, account) => Math.max(highest, account.priority), -1) +
    1;
  const account: LinkedAccountConfig = {
    id,
    providerId: input.providerId,
    label: record.label,
    source: "api-key",
    enabled: true,
    priority: nextPriority,
    prioritySource: "generated",
    createdAt: now,
    health: "ok",
  };

  saveAccount(record, storagePolicy);
  try {
    await pool.upsert(account);
  } catch (cause) {
    deleteAccount(input.providerId, id, storagePolicy);
    throw new ElizaError("First-run account adoption failed", {
      code: "FIRST_RUN_ACCOUNT_ADOPTION_FAILED",
      context: { providerId: input.providerId },
      cause,
      severity: "fatal",
    });
  }

  return {
    account,
    rollback: async () => {
      deleteAccount(input.providerId, id, storagePolicy);
      await pool.deleteMetadata(input.providerId, id);
    },
  };
}
