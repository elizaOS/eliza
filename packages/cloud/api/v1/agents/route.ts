/**
 * POST /api/v1/agents
 *
 * Service-to-service endpoint for waifu.fun to provision an Agent cloud agent.
 * Auth: X-Service-Key header.
 *
 * Default (async): create the agent record + enqueue a provisioning job.
 *   Returns 202 with `{ cloudAgentId, jobId, polling }`.
 *
 * `?sync=true` falls back to the legacy blocking behaviour and returns 201.
 */

import { Hono } from "hono";
import { isAddress } from "viem";
import { z } from "zod";
import { agentSandboxesRepository } from "@/db/repositories/agent-sandboxes";
import { userCharactersRepository } from "@/db/repositories/characters";
import {
  failureResponse,
  ValidationError,
} from "@/lib/api/cloud-worker-errors";
import { toCompatStatus } from "@/lib/api/compat-envelope";
import { requireServiceKey } from "@/lib/auth/service-key-hono-worker";
import { checkAgentCreditGate } from "@/lib/services/agent-billing-gate";
import { insufficientCredits402 } from "@/lib/services/agent-billing-gate-402";
import { charactersService } from "@/lib/services/characters/characters";
import { elizaSandboxService } from "@/lib/services/eliza-sandbox";
import { provisioningJobService } from "@/lib/services/provisioning-jobs";
import {
  checkProvisioningWorkerHealth,
  provisioningWorkerFailureBody,
} from "@/lib/services/provisioning-worker-health";
import {
  findOrCreateUserByWalletAddress,
  grantInitialCreditsToWalletAccount,
  INITIAL_FREE_CREDITS,
} from "@/lib/services/wallet-signup";
import { isUniqueConstraintError } from "@/lib/utils/db-errors";
import { logger } from "@/lib/utils/logger";
import { normalizeTokenAddress } from "@/lib/utils/token-address";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();
const WAIFU_GUEST_TOKEN_THRESHOLD = 1_000;
const WAIFU_USER_TOKEN_THRESHOLD = 100_000;

const provisionSchema = z.object({
  tokenContractAddress: z.string().min(1).max(256),
  chain: z.string().min(1).max(50),
  chainId: z.number().int().positive(),
  tokenName: z.string().min(1).max(200),
  tokenTicker: z.string().min(1).max(30),
  launchType: z.enum(["native", "imported"]),
  character: z
    .object({
      name: z.string().min(1).max(200),
      bio: z.string().max(5000).optional(),
      avatar: z.string().url().max(2048).optional(),
      config: z.record(z.string(), z.unknown()).optional(),
      system: z.string().max(20000).optional(),
      plugins: z.array(z.string().min(1).max(200)).max(50).optional(),
    })
    .optional(),
  billing: z
    .object({
      mode: z.enum(["owner_credits", "waifu_treasury_subsidy", "hybrid"]),
      initialReserveUsd: z.number().nonnegative().optional(),
    })
    .optional(),
  account: z.object({
    primaryWalletAddress: z.string().refine((value) => isAddress(value), {
      message: "account.primaryWalletAddress must be an EVM address",
    }),
    walletKeyRef: z.string().min(1).max(512).optional(),
    chainType: z.enum(["evm"]).default("evm"),
  }),
  access: z
    .object({
      guestTokenThreshold: z.number().nonnegative().optional(),
      userTokenThreshold: z.number().nonnegative().optional(),
      adminWalletAddress: z
        .string()
        .refine((value) => isAddress(value), {
          message: "access.adminWalletAddress must be an EVM address",
        })
        .optional(),
      roles: z.record(z.string(), z.unknown()).optional(),
    })
    .optional(),
  container: z
    .object({
      image: z.string().min(1).max(512).optional(),
      projectName: z.string().min(1).max(200).optional(),
      port: z.number().int().positive().max(65535).optional(),
      cpu: z.number().positive().optional(),
      memory: z.number().positive().optional(),
      desiredCount: z.number().int().positive().optional(),
      architecture: z.enum(["arm64", "x86_64"]).optional(),
      healthCheckPath: z.string().min(1).max(256).optional(),
      env: z.record(z.string(), z.string()).optional(),
    })
    .optional(),
  modelDefaults: z.record(z.string(), z.string()).optional(),
  webhookUrl: z.string().url().max(2048).optional(),
  webhookSecret: z.string().min(8).max(512).optional(),
});

function recordFromUnknown(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringFromRecord(
  data: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = data[key];
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function resolveAdminWallets(
  access: z.infer<typeof provisionSchema>["access"],
): string[] {
  const wallets = new Set<string>();
  if (access?.adminWalletAddress) wallets.add(access.adminWalletAddress);

  const roles = recordFromUnknown(access?.roles);
  const adminRole = recordFromUnknown(roles.admin);
  const roleWallets = adminRole.wallets;
  if (Array.isArray(roleWallets)) {
    for (const wallet of roleWallets) {
      if (typeof wallet === "string" && wallet.trim()) {
        wallets.add(wallet.trim());
      }
    }
  }

  return [...wallets];
}

async function duplicateTokenResponseBody(
  existingChar: { id: string },
  tokenContractAddress: string,
  chain: string,
): Promise<Record<string, unknown>> {
  const existingSandbox =
    await agentSandboxesRepository.findLatestByCharacterId(existingChar.id);

  return {
    error: `An agent is already linked to token ${tokenContractAddress} on ${chain}`,
    existingCharacterId: existingChar.id,
    ...(existingSandbox?.id ? { existingAgentId: existingSandbox.id } : {}),
  };
}

app.post("/", async (c) => {
  try {
    const identity = await requireServiceKey(c);

    const body = await c.req.json().catch(() => null);
    if (!body) throw ValidationError("Invalid JSON body");

    const parsed = provisionSchema.safeParse(body);
    if (!parsed.success) {
      throw ValidationError("Invalid request data", {
        details: parsed.error.issues,
      });
    }

    const p = parsed.data;
    const sync = c.req.query("sync") === "true";
    const agentName = p.character?.name || p.tokenName;
    const characterConfig = recordFromUnknown(p.character?.config);
    const waifuAgentId = stringFromRecord(characterConfig, "waifuAgentId");
    const adminWallets = resolveAdminWallets(p.access);
    const guestTokenThreshold =
      p.access?.guestTokenThreshold ?? WAIFU_GUEST_TOKEN_THRESHOLD;
    const userTokenThreshold =
      p.access?.userTokenThreshold ?? WAIFU_USER_TOKEN_THRESHOLD;
    const accessConfig = {
      ...(p.access ?? {}),
      guestTokenThreshold,
      userTokenThreshold,
    };
    const normalizedTokenAddress = normalizeTokenAddress(
      p.tokenContractAddress,
      p.chain,
    );
    const existingChar = await userCharactersRepository.findByTokenAddress(
      normalizedTokenAddress,
      p.chain,
    );
    if (existingChar) {
      return c.json(
        await duplicateTokenResponseBody(
          existingChar,
          p.tokenContractAddress,
          p.chain,
        ),
        409,
      );
    }
    const billingConfig = p.billing ?? {
      mode: "owner_credits" as const,
      initialReserveUsd: INITIAL_FREE_CREDITS,
    };
    const invalidAdminWallet = adminWallets.find(
      (wallet) => !isAddress(wallet),
    );
    if (invalidAdminWallet) {
      throw ValidationError("Invalid request data", {
        details: [
          {
            path: ["access", "roles", "admin", "wallets"],
            message: "admin role wallet must be an EVM address",
          },
        ],
      });
    }
    const walletAccount = p.account?.primaryWalletAddress
      ? await findOrCreateUserByWalletAddress(p.account.primaryWalletAddress, {
          grantInitialCredits: false,
        })
      : null;
    const owner = walletAccount?.user
      ? {
          organizationId: walletAccount.user.organization_id,
          userId: walletAccount.user.id,
        }
      : identity;
    const ownerOrganizationId = owner.organizationId;
    const ownerUserId = owner.userId;
    if (!ownerOrganizationId || !ownerUserId) {
      throw ValidationError("Agent owner account is not billable");
    }

    if (!sync) {
      const workerHealth = await checkProvisioningWorkerHealth();
      if (!workerHealth.ok) {
        logger.warn(
          "[service-api] Agent provisioning blocked: worker unavailable",
          {
            orgId: ownerOrganizationId,
            code: workerHealth.code,
          },
        );
        return c.json(
          provisioningWorkerFailureBody(workerHealth),
          workerHealth.status,
        );
      }
    }

    logger.info("[service-api] Provisioning agent", {
      token: normalizedTokenAddress,
      chain: p.chain,
      chainId: p.chainId,
      orgId: ownerOrganizationId,
      serviceOrgId: identity.organizationId,
      walletOwned: Boolean(walletAccount),
      async: !sync,
    });

    let character: Awaited<ReturnType<typeof charactersService.create>>;
    try {
      character = await charactersService.create({
        name: agentName,
        bio: p.character?.bio
          ? [p.character.bio]
          : [`Agent for ${p.tokenName}`],
        user_id: ownerUserId,
        organization_id: ownerOrganizationId,
        source: "cloud",
        character_data: p.character?.config ?? {},
        avatar_url: p.character?.avatar ?? null,
        token_address: normalizedTokenAddress,
        token_chain: p.chain,
        token_name: p.tokenName,
        token_ticker: p.tokenTicker,
      });
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        const existing = await userCharactersRepository.findByTokenAddress(
          normalizedTokenAddress,
          p.chain,
        );
        return c.json(
          existing?.id
            ? await duplicateTokenResponseBody(
                existing,
                p.tokenContractAddress,
                p.chain,
              )
            : {
                error: `An agent is already linked to token ${p.tokenContractAddress} on ${p.chain}`,
              },
          409,
        );
      }
      throw error;
    }

    let initialCreditsGranted = false;
    let initialFreeCreditsUsd = 0;
    let agent: Awaited<
      ReturnType<typeof elizaSandboxService.createAgent>
    >["agent"];
    try {
      if (walletAccount?.isNewAccount && p.account?.primaryWalletAddress) {
        const creditGrant = await grantInitialCreditsToWalletAccount({
          organizationId: ownerOrganizationId,
          walletAddress: p.account.primaryWalletAddress,
          requireInitialCredits: true,
        });
        initialCreditsGranted = creditGrant.initialCreditsGranted;
        initialFreeCreditsUsd = creditGrant.initialFreeCreditsUsd;
      }

      const creditCheck = await checkAgentCreditGate(ownerOrganizationId);
      if (!creditCheck.allowed) {
        await charactersService.delete(character.id);
        return c.json(
          insufficientCredits402(
            creditCheck,
            "[service-api] Provisioning blocked: insufficient credits",
            {
              orgId: ownerOrganizationId,
              serviceOrgId: identity.organizationId,
              walletOwned: Boolean(walletAccount),
            },
          ),
          402,
        );
      }

      ({ agent } = await elizaSandboxService.createAgent({
        organizationId: ownerOrganizationId,
        userId: ownerUserId,
        agentName,
        characterId: character.id,
        agentConfig: {
          ...(waifuAgentId ? { waifuAgentId } : {}),
          tokenContractAddress: normalizedTokenAddress,
          chain: p.chain,
          chainId: p.chainId,
          tokenName: p.tokenName,
          tokenTicker: p.tokenTicker,
          launchType: p.launchType,
          character: p.character,
          billing: billingConfig,
          account: p.account
            ? {
                primaryWalletAddress: p.account.primaryWalletAddress,
                walletKeyRef: p.account.walletKeyRef,
                chainType: p.account.chainType,
                elizaCloudOrganizationId: ownerOrganizationId,
                elizaCloudUserId: ownerUserId,
              }
            : undefined,
          access: accessConfig,
          modelDefaults: p.modelDefaults,
          ...(p.container
            ? {
                container: {
                  ...(p.container.image ? { image: p.container.image } : {}),
                  ...(p.container.projectName
                    ? { projectName: p.container.projectName }
                    : {}),
                  ...(p.container.port ? { port: p.container.port } : {}),
                  ...(p.container.cpu ? { cpu: p.container.cpu } : {}),
                  ...(p.container.memory ? { memory: p.container.memory } : {}),
                  ...(p.container.desiredCount
                    ? { desiredCount: p.container.desiredCount }
                    : {}),
                  ...(p.container.architecture
                    ? { architecture: p.container.architecture }
                    : {}),
                  ...(p.container.healthCheckPath
                    ? { healthCheckPath: p.container.healthCheckPath }
                    : {}),
                },
              }
            : {}),
          ...(p.webhookUrl
            ? {
                webhookUrl: p.webhookUrl,
                webhookSecret: p.webhookSecret,
                waifuWebhook: {
                  url: p.webhookUrl,
                  secret: p.webhookSecret,
                },
              }
            : {}),
        },
        environmentVars: {
          ...(waifuAgentId ? { WAIFU_AGENT_ID: waifuAgentId } : {}),
          TOKEN_CONTRACT_ADDRESS: normalizedTokenAddress,
          TOKEN_CHAIN: p.chain,
          TOKEN_CHAIN_ID: String(p.chainId),
          TOKEN_NAME: p.tokenName,
          TOKEN_TICKER: p.tokenTicker,
          ...(p.account?.primaryWalletAddress
            ? {
                AGENT_PRIMARY_WALLET_ADDRESS: p.account.primaryWalletAddress,
                WAIFU_AGENT_EVM_ADDRESS: p.account.primaryWalletAddress,
                AGENT_WALLET_CHAIN_TYPE: p.account.chainType,
                ELIZA_CLOUD_ACCOUNT_ORG_ID: ownerOrganizationId,
                WAIFU_ELIZA_CLOUD_ACCOUNT_ORG_ID: ownerOrganizationId,
                ...(p.account.walletKeyRef
                  ? {
                      AGENT_PRIMARY_WALLET_KEY_REF: p.account.walletKeyRef,
                      WAIFU_AGENT_EVM_KEY_REF: p.account.walletKeyRef,
                    }
                  : {}),
              }
            : {}),
          ...(adminWallets.length > 0
            ? {
                AGENT_ADMIN_WALLET_ADDRESS: adminWallets[0],
                WAIFU_ACCESS_ADMIN_WALLETS: adminWallets.join(","),
              }
            : {}),
          AGENT_GUEST_TOKEN_THRESHOLD: String(guestTokenThreshold),
          WAIFU_ACCESS_GUEST_MIN_TOKENS: String(guestTokenThreshold),
          AGENT_USER_TOKEN_THRESHOLD: String(userTokenThreshold),
          WAIFU_ACCESS_USER_MIN_TOKENS: String(userTokenThreshold),
          WAIFU_ACCESS_THRESHOLD_MODE: "strict_gt",
          ...(p.modelDefaults ?? {}),
          ...(p.container?.port ? { PORT: String(p.container.port) } : {}),
          ...(p.container?.env ?? {}),
          ELIZA_UI_ENABLE: "true",
        },
        dockerImage: p.container?.image,
      }));
    } catch (createErr) {
      try {
        await charactersService.delete(character.id);
        logger.info(
          "[service-api] Cleaned up orphaned character after createAgent failure",
          {
            characterId: character.id,
          },
        );
      } catch (cleanupErr) {
        logger.error("[service-api] Failed to clean up orphaned character", {
          characterId: character.id,
          error:
            cleanupErr instanceof Error
              ? cleanupErr.message
              : String(cleanupErr),
        });
      }
      throw createErr;
    }

    if (sync) {
      const result = await elizaSandboxService.provision(
        agent.id,
        ownerOrganizationId,
      );
      if (!result.success) {
        logger.error("[service-api] Provision failed", {
          agentId: agent.id,
          error: result.error,
        });
        return c.json(
          {
            cloudAgentId: agent.id,
            status: result.sandboxRecord?.status ?? "error",
            error: result.error,
          },
          502,
        );
      }
      logger.info("[service-api] Agent provisioned (sync)", {
        agentId: agent.id,
        status: result.sandboxRecord.status,
      });
      const statusPayload = toCompatStatus(result.sandboxRecord);
      return c.json(
        {
          cloudAgentId: agent.id,
          characterId: character.id,
          containerId: statusPayload.containerId,
          containerUrl: statusPayload.containerUrl,
          bridgeUrl: statusPayload.bridgeUrl,
          webUiUrl: statusPayload.webUiUrl,
          status: result.sandboxRecord.status,
          token_address: character.token_address ?? null,
          token_chain: character.token_chain ?? null,
          token_name: character.token_name ?? null,
          token_ticker: character.token_ticker ?? null,
          account: walletAccount
            ? {
                primaryWalletAddress: p.account?.primaryWalletAddress ?? null,
                walletKeyRef: p.account?.walletKeyRef ?? null,
                organizationId: ownerOrganizationId,
                userId: ownerUserId,
                isNewAccount: walletAccount.isNewAccount,
                initialCreditsGranted,
                initialFreeCreditsUsd,
              }
            : null,
        },
        201,
      );
    }

    let job: Awaited<
      ReturnType<typeof provisioningJobService.enqueueAgentProvision>
    >;
    try {
      job = await provisioningJobService.enqueueAgentProvision({
        agentId: agent.id,
        organizationId: ownerOrganizationId,
        userId: ownerUserId,
        agentName,
        webhookUrl: p.webhookUrl,
      });
    } catch (enqueueErr) {
      try {
        await charactersService.delete(character.id);
        logger.info(
          "[service-api] Cleaned up orphaned character after enqueue failure",
          {
            characterId: character.id,
            agentId: agent.id,
          },
        );
      } catch (cleanupErr) {
        logger.error(
          "[service-api] Failed to clean up orphaned character after enqueue failure",
          {
            characterId: character.id,
            agentId: agent.id,
            error:
              cleanupErr instanceof Error
                ? cleanupErr.message
                : String(cleanupErr),
          },
        );
      }
      throw enqueueErr;
    }

    logger.info("[service-api] Agent provisioning job enqueued", {
      agentId: agent.id,
      jobId: job.id,
    });

    return c.json(
      {
        cloudAgentId: agent.id,
        characterId: character.id,
        status: "pending",
        jobId: job.id,
        polling: {
          endpoint: `/api/v1/jobs/${job.id}`,
          intervalMs: 5000,
          expectedDurationMs: 90000,
        },
        token_address: character.token_address ?? null,
        token_chain: character.token_chain ?? null,
        token_name: character.token_name ?? null,
        token_ticker: character.token_ticker ?? null,
        account: walletAccount
          ? {
              primaryWalletAddress: p.account?.primaryWalletAddress ?? null,
              walletKeyRef: p.account?.walletKeyRef ?? null,
              organizationId: ownerOrganizationId,
              userId: ownerUserId,
              isNewAccount: walletAccount.isNewAccount,
              initialCreditsGranted,
              initialFreeCreditsUsd,
            }
          : null,
      },
      202,
    );
  } catch (error) {
    return failureResponse(c, error);
  }
});

export default app;
