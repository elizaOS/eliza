import { getContractAddresses, getRpcUrl } from "@polyagent/contracts";
import {
  and,
  balanceTransactions,
  Decimal,
  db,
  eq,
  follows,
  referrals,
  sql,
  users,
} from "@polyagent/db";
import type {
  AgentCapabilities,
  AuthenticatedUser,
  JsonValue,
  StringRecord,
} from "@polyagent/shared";
import {
  BusinessLogicError,
  generateSnowflakeId,
  IDENTITY_REGISTRY_ABI,
  InternalServerError,
  identityRegistryAbi,
  logger,
  POINTS,
  reputationSystemAbi,
  ValidationError,
} from "@polyagent/shared";
import {
  type Account,
  type Address,
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  http,
  type Log,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia, foundry } from "viem/chains";

/**
 * Agent0Client interface for dependency injection
 *
 * @description Client interface for Agent0 registry operations, injected from
 * the web application layer to avoid circular dependencies.
 */
type Agent0Client = {
  registerAgent: (params: {
    name: string;
    description: string;
    imageUrl?: string;
    walletAddress: string;
    a2aEndpoint: string;
    capabilities: AgentCapabilities;
  }) => Promise<{ tokenId: number; metadataCID?: string }>;
};

/**
 * OnboardingServices interface for dependency injection
 *
 * @description Service interfaces for onboarding operations, injected from
 * the web application layer to avoid circular dependencies.
 */
type OnboardingServices = {
  getAgent0Client: () => Agent0Client;
  syncAfterAgent0Registration: (
    userId: string,
    tokenId: number,
  ) => Promise<void>;
  notifyNewAccount: (userId: string) => Promise<void>;
  pointsService: {
    awardReferralSignup: (
      referrerId: string,
      referredUserId: string,
    ) => Promise<{
      success: boolean;
      pointsAwarded: number;
      error?: string;
    }>;
    awardPoints: (
      userId: string,
      amount: number,
      reason: string,
      metadata?: StringRecord<JsonValue>,
    ) => Promise<{
      success: boolean;
      pointsAwarded: number;
      newTotal: number;
    }>;
  };
  getOrCreateReferralCode: (userId: string) => Promise<string>;
};

let onboardingServicesInstance: OnboardingServices | null = null;

export function setOnboardingServices(services: OnboardingServices): void {
  onboardingServicesInstance = services;
}

function getOnboardingServices(): OnboardingServices {
  if (!onboardingServicesInstance) {
    throw new Error(
      "OnboardingServices not initialized. Call setOnboardingServices() first.",
    );
  }
  return onboardingServicesInstance;
}

// Get contract addresses based on environment
const contracts = getContractAddresses();
export const IDENTITY_REGISTRY = contracts.identityRegistry;
export const REPUTATION_SYSTEM = contracts.reputationSystem as Address;

// Hardhat default account #0 private key (has 10000 ETH on local node)
const HARDHAT_DEFAULT_PRIVATE_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;

// Use Hardhat's pre-funded account for local development, otherwise use env var
const chainId = Number(process.env.NEXT_PUBLIC_CHAIN_ID || 31337);
export const DEPLOYER_PRIVATE_KEY: `0x${string}` =
  chainId === 31337
    ? HARDHAT_DEFAULT_PRIVATE_KEY
    : (process.env.DEPLOYER_PRIVATE_KEY as `0x${string}`);

export interface OnchainRegistrationInput {
  user: AuthenticatedUser;
  walletAddress?: string | null;
  username?: string | null;
  displayName?: string | null;
  bio?: string | null;
  profileImageUrl?: string | null;
  coverImageUrl?: string | null;
  endpoint?: string | null;
  referralCode?: string | null;
  txHash?: string | null;
}

export interface OnchainRegistrationResult {
  message: string;
  tokenId?: number;
  txHash?: string;
  pointsAwarded?: number;
  alreadyRegistered: boolean;
  userId: string;
}

export async function processOnchainRegistration({
  user,
  walletAddress,
  username,
  displayName,
  bio,
  profileImageUrl,
  coverImageUrl,
  endpoint,
  referralCode,
  txHash,
}: OnchainRegistrationInput): Promise<OnchainRegistrationResult> {
  if (!user.isAgent && !walletAddress) {
    throw new BusinessLogicError(
      "Wallet address is required for non-agent users",
      "WALLET_REQUIRED",
    );
  }

  const finalUsername =
    username ||
    `user_${Math.random().toString(36).substring(2, 10)}_${Date.now().toString(36).substring(2, 6)}`;

  if (walletAddress && !/^0x[a-fA-F0-9]{40}$/.test(walletAddress)) {
    throw new ValidationError(
      "Invalid wallet address format",
      ["walletAddress"],
      [
        {
          field: "walletAddress",
          message: "Must be a valid Ethereum address (0x...)",
        },
      ],
    );
  }

  let submittedTxHash: `0x${string}` | undefined;
  if (txHash) {
    if (typeof txHash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
      throw new ValidationError(
        "Invalid transaction hash format",
        ["txHash"],
        [
          {
            field: "txHash",
            message: "Must be a 0x-prefixed 64 character hash",
          },
        ],
      );
    }
    submittedTxHash = txHash as `0x${string}`;
  }

  let referrerId: string | null = null;
  if (referralCode) {
    // Case-insensitive username lookup for referral
    const [referrer] = await db
      .select({ id: users.id })
      .from(users)
      .where(sql`lower(${users.username}) = lower(${referralCode})`)
      .limit(1);

    // Prevent self-referral by username
    if (referrer && referrer.id !== user.userId) {
      referrerId = referrer.id;
      logger.info(
        "Valid referral code (username) found",
        { referralCode, referrerId },
        "OnboardingOnchain",
      );
    } else {
      // Look up who owns this referral code
      const [referralOwner] = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.referralCode, referralCode))
        .limit(1);

      // Prevent self-referral by referral code
      if (referralOwner && referralOwner.id !== user.userId) {
        referrerId = referralOwner.id;
        logger.info(
          "Valid referral code found",
          { referralCode, referrerId },
          "OnboardingOnchain",
        );
      } else if (
        referrer?.id === user.userId ||
        referralOwner?.id === user.userId
      ) {
        logger.warn(
          "Self-referral attempt blocked",
          { userId: user.userId, referralCode },
          "OnboardingOnchain",
        );
      }
    }
  }

  let dbUser: {
    id: string;
    username: string | null;
    walletAddress: string | null;
    onChainRegistered: boolean;
    nftTokenId: number | null;
    referredBy: string | null;
  } | null = null;

  if (user.isAgent) {
    // Case-insensitive username lookup for agent
    const [existingUser] = await db
      .select({
        id: users.id,
        username: users.username,
        walletAddress: users.walletAddress,
        onChainRegistered: users.onChainRegistered,
        nftTokenId: users.nftTokenId,
        referredBy: users.referredBy,
      })
      .from(users)
      .where(sql`lower(${users.username}) = lower(${user.userId})`)
      .limit(1);
    dbUser = existingUser ?? null;

    if (!dbUser) {
      const newId = await generateSnowflakeId();
      const [createdUser] = await db
        .insert(users)
        .values({
          id: newId,
          privyId: user.userId,
          username: user.userId,
          displayName: displayName || username || user.userId,
          bio: bio || `Autonomous AI agent: ${user.userId}`,
          profileImageUrl: profileImageUrl || null,
          coverImageUrl: coverImageUrl || null,
          isActor: false,
          virtualBalance: "10000",
          totalDeposited: "10000",
          updatedAt: new Date(),
        })
        .returning({
          id: users.id,
          username: users.username,
          walletAddress: users.walletAddress,
          onChainRegistered: users.onChainRegistered,
          nftTokenId: users.nftTokenId,
          referredBy: users.referredBy,
        });
      dbUser = createdUser ?? null;
    }
  } else {
    const [existingUser] = await db
      .select({
        id: users.id,
        username: users.username,
        walletAddress: users.walletAddress,
        onChainRegistered: users.onChainRegistered,
        nftTokenId: users.nftTokenId,
        referredBy: users.referredBy,
      })
      .from(users)
      .where(eq(users.id, user.userId))
      .limit(1);
    dbUser = existingUser ?? null;

    if (!dbUser) {
      const [createdUser] = await db
        .insert(users)
        .values({
          id: user.userId,
          privyId: user.privyId ?? user.userId,
          walletAddress: walletAddress?.toLowerCase() ?? null,
          username: finalUsername,
          displayName: displayName || finalUsername,
          bio: bio || "",
          profileImageUrl: profileImageUrl || null,
          coverImageUrl: coverImageUrl || null,
          isActor: false,
          virtualBalance: "0",
          totalDeposited: "0",
          referredBy: referrerId,
          updatedAt: new Date(),
        })
        .returning({
          id: users.id,
          username: users.username,
          walletAddress: users.walletAddress,
          onChainRegistered: users.onChainRegistered,
          nftTokenId: users.nftTokenId,
          referredBy: users.referredBy,
        });
      dbUser = createdUser ?? null;
    } else {
      const [fullUser] = await db
        .select()
        .from(users)
        .where(eq(users.id, dbUser.id))
        .limit(1);
      const [updatedUser] = await db
        .update(users)
        .set({
          walletAddress: walletAddress?.toLowerCase() ?? dbUser.walletAddress,
          username: finalUsername || dbUser.username,
          displayName: displayName || finalUsername || fullUser?.displayName,
          bio: bio || fullUser?.bio,
          profileImageUrl: profileImageUrl ?? fullUser?.profileImageUrl,
          coverImageUrl: coverImageUrl ?? fullUser?.coverImageUrl,
          referredBy: referrerId ?? dbUser.referredBy ?? undefined,
        })
        .where(eq(users.id, dbUser.id))
        .returning({
          id: users.id,
          username: users.username,
          walletAddress: users.walletAddress,
          onChainRegistered: users.onChainRegistered,
          nftTokenId: users.nftTokenId,
          referredBy: users.referredBy,
        });
      dbUser = updatedUser ?? null;
    }
  }

  if (!dbUser) {
    throw new InternalServerError("Failed to create or retrieve user record");
  }

  if (!referrerId && dbUser.referredBy) {
    referrerId = dbUser.referredBy;
  }

  const chainId = Number(process.env.NEXT_PUBLIC_CHAIN_ID || 31337);

  // Create publicClient at function scope for use throughout registration flow
  const publicClient = createPublicClient({
    chain: chainId === 31337 ? foundry : baseSepolia,
    transport: http(getRpcUrl()),
  });

  let isRegistered = false;
  let tokenId: number | null = dbUser.nftTokenId;

  if (user.isAgent) {
    // Agents use database state
    isRegistered = dbUser.onChainRegistered && dbUser.nftTokenId !== null;
  } else {
    const address = walletAddress! as Address;

    // In local dev, contracts may not be deployed yet during startup
    // Check if contract exists before calling it
    const contractCode = await publicClient.getCode({
      address: IDENTITY_REGISTRY,
    });
    const contractExists =
      contractCode && contractCode !== "0x" && contractCode.length > 2;

    if (!contractExists) {
      // Contract not deployed yet - use database state
      logger.warn(
        "Identity registry contract not deployed yet, using database state",
        { contractAddress: IDENTITY_REGISTRY, chainId },
        "processOnchainRegistration",
      );
      isRegistered = dbUser.onChainRegistered && dbUser.nftTokenId !== null;
    } else {
      // Contract exists - check blockchain for registration status
      isRegistered = await publicClient.readContract({
        address: IDENTITY_REGISTRY,
        abi: identityRegistryAbi,
        functionName: "isRegistered",
        args: [address],
      });

      if (isRegistered && !tokenId) {
        tokenId = Number(
          await publicClient.readContract({
            address: IDENTITY_REGISTRY,
            abi: identityRegistryAbi,
            functionName: "getTokenId",
            args: [address],
          }),
        );
      }
    }
  }

  if (isRegistered && tokenId) {
    // User is already registered on-chain, sync the DB if needed
    if (!dbUser.onChainRegistered || dbUser.nftTokenId !== tokenId) {
      await db
        .update(users)
        .set({
          onChainRegistered: true,
          nftTokenId: tokenId,
        })
        .where(eq(users.id, dbUser.id));
      logger.info(
        "Synced on-chain registration status to database",
        { userId: dbUser.id, tokenId, wasRegistered: dbUser.onChainRegistered },
        "processOnchainRegistration",
      );
    }

    const [hasWelcomeBonus] = await db
      .select({ id: balanceTransactions.id })
      .from(balanceTransactions)
      .where(
        and(
          eq(balanceTransactions.userId, dbUser.id),
          eq(balanceTransactions.description, "Welcome bonus - initial signup"),
        ),
      )
      .limit(1);

    logger.info(
      "User already registered on-chain, returning existing registration",
      { userId: dbUser.id, tokenId, alreadyRegistered: true },
      "processOnchainRegistration",
    );

    return {
      message: "Already registered on-chain",
      tokenId,
      alreadyRegistered: true,
      userId: dbUser.id,
      pointsAwarded: hasWelcomeBonus ? 1000 : 0,
    };
  }

  // Validate deployer private key format
  const deployerConfigured =
    Boolean(DEPLOYER_PRIVATE_KEY) &&
    typeof DEPLOYER_PRIVATE_KEY === "string" &&
    /^0x[0-9a-fA-F]{64}$/.test(DEPLOYER_PRIVATE_KEY);

  let deployerAccount: Account | null = null;
  let walletClient: WalletClient | null = null;

  if (deployerConfigured) {
    const chainId = Number(process.env.NEXT_PUBLIC_CHAIN_ID || 31337);
    deployerAccount = privateKeyToAccount(DEPLOYER_PRIVATE_KEY!);
    walletClient = createWalletClient({
      account: deployerAccount,
      chain: chainId === 31337 ? foundry : baseSepolia,
      transport: http(getRpcUrl()),
    });
  }

  if (!submittedTxHash && !deployerConfigured) {
    throw new InternalServerError(
      "Server wallet not configured for gas payments",
      { missing: "DEPLOYER_PRIVATE_KEY" },
    );
  }

  const name = username || (user.isAgent ? user.userId : finalUsername);
  let registrationAddress: Address;
  let agentEndpoint: string;

  if (user.isAgent) {
    if (!deployerAccount) {
      throw new InternalServerError(
        "Server wallet required for agent registration",
        { missing: "DEPLOYER_PRIVATE_KEY" },
      );
    }
    registrationAddress = deployerAccount.address;
    const baseEndpoint =
      endpoint || `https://polyagent.market/agent/${user.userId}`;
    agentEndpoint = `${baseEndpoint}?agentId=${user.userId}`;
  } else {
    registrationAddress = walletAddress! as Address;
    agentEndpoint =
      endpoint ||
      `https://polyagent.market/agent/${walletAddress?.toLowerCase()}`;
  }

  const capabilitiesHash =
    "0x0000000000000000000000000000000000000000000000000000000000000001" as `0x${string}`;
  const metadataURI = JSON.stringify({
    name,
    bio: bio || "",
    type: user.isAgent ? "elizaos-agent" : "user",
    registered: new Date().toISOString(),
  });

  logger.info(
    "Registering on-chain",
    {
      isAgent: user.isAgent,
      address: registrationAddress,
      name,
      endpoint: agentEndpoint,
    },
    "OnboardingOnchain",
  );

  let registrationTxHash: `0x${string}` | undefined = submittedTxHash;
  let receipt: Awaited<
    ReturnType<typeof publicClient.waitForTransactionReceipt>
  > | null = null;

  if (submittedTxHash) {
    logger.info(
      "Validating submitted registration transaction",
      { txHash: submittedTxHash },
      "OnboardingOnchain",
    );

    receipt = await publicClient.waitForTransactionReceipt({
      hash: submittedTxHash,
      confirmations: 1,
    });

    if (receipt.status !== "success") {
      throw new BusinessLogicError(
        "Submitted blockchain registration transaction failed",
        "REGISTRATION_TX_FAILED",
        { txHash: submittedTxHash, receipt: receipt.status },
      );
    }
  } else if (walletClient) {
    registrationTxHash = await walletClient.writeContract({
      address: IDENTITY_REGISTRY,
      abi: identityRegistryAbi,
      functionName: "registerAgent",
      args: [name, agentEndpoint, capabilitiesHash, metadataURI],
    } as unknown as Parameters<typeof walletClient.writeContract>[0]);

    logger.info(
      "Registration transaction sent",
      { txHash: registrationTxHash },
      "OnboardingOnchain",
    );

    if (!registrationTxHash) {
      throw new InternalServerError(
        "Registration transaction hash is missing",
        { missing: "registrationTxHash" },
      );
    }
    receipt = await publicClient.waitForTransactionReceipt({
      hash: registrationTxHash,
      confirmations: 2,
    });

    if (receipt.status !== "success") {
      throw new BusinessLogicError(
        "Blockchain registration transaction failed",
        "REGISTRATION_TX_FAILED",
        {
          txHash: registrationTxHash,
          receipt: receipt.status,
        },
      );
    }
  } else {
    throw new InternalServerError(
      "Unable to determine registration transaction result",
      {
        hasSubmittedTx: Boolean(submittedTxHash),
        deployerConfigured,
      },
    );
  }

  const finalizedReceipt = receipt;
  if (!finalizedReceipt) {
    throw new InternalServerError(
      "Registration transaction receipt missing after processing",
    );
  }

  // Debug: log all events in receipt
  logger.info(
    "Transaction receipt logs",
    {
      txHash: registrationTxHash ?? submittedTxHash,
      totalLogs: finalizedReceipt.logs.length,
      logAddresses: finalizedReceipt.logs.map((l: Log) => l.address),
      identityRegistryAddress: IDENTITY_REGISTRY,
    },
    "processOnchainRegistration",
  );

  // Filter logs by contract address first to avoid decoding errors on Transfer events
  const contractLogs = finalizedReceipt.logs.filter(
    (log: Log) => log.address.toLowerCase() === IDENTITY_REGISTRY.toLowerCase(),
  );

  logger.info(
    "Filtered contract logs",
    {
      contractLogsCount: contractLogs.length,
      topics: contractLogs.map((l: Log) => l.topics),
    },
    "processOnchainRegistration",
  );

  const agentRegisteredLog = contractLogs.find((log: Log) => {
    if (log.topics.length === 0) {
      return false;
    }
    const decodedLog = decodeEventLog({
      abi: identityRegistryAbi,
      data: log.data,
      topics: log.topics,
      strict: false,
    });
    logger.info(
      "Decoded log event",
      { eventName: decodedLog.eventName },
      "processOnchainRegistration",
    );
    return decodedLog.eventName === "AgentRegistered";
  });

  if (!agentRegisteredLog) {
    throw new InternalServerError(
      "AgentRegistered event not found in receipt",
      {
        txHash: registrationTxHash ?? submittedTxHash,
        totalLogs: finalizedReceipt.logs.length,
        contractLogs: contractLogs.length,
        allLogAddresses: finalizedReceipt.logs.map((l: Log) =>
          l.address.toLowerCase(),
        ),
        expectedAddress: IDENTITY_REGISTRY.toLowerCase(),
      },
    );
  }

  const decodedLog = decodeEventLog({
    abi: IDENTITY_REGISTRY_ABI,
    data: agentRegisteredLog.data,
    topics: agentRegisteredLog.topics,
  });

  const args = decodedLog.args as { tokenId?: bigint } | undefined;
  tokenId = args?.tokenId ? Number(args.tokenId) : 0;
  logger.info("Registered with token ID", { tokenId }, "OnboardingOnchain");
  if (walletClient) {
    logger.info(
      "Bootstrapping on-chain reputation via feedback...",
      undefined,
      "OnboardingOnchain",
    );
    const bootstrapTx = await walletClient.writeContract({
      address: REPUTATION_SYSTEM,
      abi: reputationSystemAbi,
      functionName: "submitFeedback",
      args: [BigInt(tokenId), 1, "Bootstrap reputation"],
    } as unknown as Parameters<typeof walletClient.writeContract>[0]);
    await publicClient.waitForTransactionReceipt({
      hash: bootstrapTx,
      confirmations: 1,
    });
    logger.info(
      "Initial on-chain feedback submitted (rating=+1)",
      undefined,
      "OnboardingOnchain",
    );
  } else {
    logger.warn(
      "Skipping reputation bootstrap because deployer wallet is not configured",
      { userId: dbUser.id },
      "OnboardingOnchain",
    );
  }

  await db
    .update(users)
    .set({
      onChainRegistered: true,
      nftTokenId: tokenId,
      registrationTxHash: registrationTxHash ?? submittedTxHash ?? null,
      // Store registration blockchain metadata
      registrationBlockNumber: BigInt(finalizedReceipt.blockNumber),
      registrationGasUsed: BigInt(finalizedReceipt.gasUsed),
      registrationTimestamp: new Date(),
      username: user.isAgent ? user.userId : username || dbUser.username,
      displayName: displayName || username || dbUser.username || user.userId,
      bio:
        bio ||
        (user.isAgent ? `Autonomous AI agent: ${user.userId}` : undefined) ||
        dbUser.username ||
        null,
      profileImageUrl: profileImageUrl ?? undefined,
      coverImageUrl: coverImageUrl ?? undefined,
    })
    .where(eq(users.id, dbUser.id));

  if (user.isAgent) {
    const agent0Client = getOnboardingServices().getAgent0Client();

    // Use individual agent's A2A endpoint if provided, otherwise construct it
    const baseUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
    const individualAgentA2AEndpoint =
      endpoint || `${baseUrl}/api/agents/${dbUser.id}/a2a`;

    const agent0Result = await agent0Client.registerAgent({
      name: username || dbUser.username || user.userId,
      description: bio || `Autonomous AI agent: ${user.userId}`,
      imageUrl: profileImageUrl ?? undefined,
      walletAddress: registrationAddress,
      a2aEndpoint: individualAgentA2AEndpoint,
      capabilities: {
        strategies: ["momentum"],
        markets: ["prediction"],
        actions: ["analyze"],
        version: "1.0.0",
      } as AgentCapabilities,
    });

    // Store Agent0 registration metadata
    await db
      .update(users)
      .set({
        agent0TokenId: agent0Result.tokenId,
        agent0MetadataCID: agent0Result.metadataCID ?? null,
        agent0RegisteredAt: new Date(),
      })
      .where(eq(users.id, dbUser.id));

    logger.info(
      "Agent registered with Agent0",
      {
        agentId: user.userId,
        agent0TokenId: agent0Result.tokenId,
        metadataCID: agent0Result.metadataCID,
      },
      "OnboardingOnchain",
    );

    // Sync on-chain reputation to local database
    const services = getOnboardingServices();
    await services.syncAfterAgent0Registration(dbUser.id, agent0Result.tokenId);
    logger.info(
      "Agent0 reputation synced successfully",
      {
        userId: dbUser.id,
        agent0TokenId: agent0Result.tokenId,
      },
      "OnboardingOnchain",
    );
  }

  const [userWithBalance] = await db
    .select({ virtualBalance: users.virtualBalance })
    .from(users)
    .where(eq(users.id, dbUser.id))
    .limit(1);

  const balanceBefore = new Decimal(userWithBalance?.virtualBalance ?? "0");
  const amountDecimal = new Decimal("1000");
  const balanceAfter = Decimal.add(balanceBefore, amountDecimal);

  await db.insert(balanceTransactions).values({
    id: await generateSnowflakeId(),
    userId: dbUser.id,
    type: "deposit",
    amount: amountDecimal.toString(),
    balanceBefore: balanceBefore.toString(),
    balanceAfter: balanceAfter.toString(),
    description: "Welcome bonus - initial signup",
    createdAt: new Date(),
  });

  // Get current balances and update with increment
  const currentBalance = Number(userWithBalance?.virtualBalance ?? "0");
  const [currentUser] = await db
    .select({ totalDeposited: users.totalDeposited })
    .from(users)
    .where(eq(users.id, dbUser.id))
    .limit(1);
  const currentDeposited = Number(currentUser?.totalDeposited ?? "0");

  await db
    .update(users)
    .set({
      virtualBalance: String(currentBalance + 1000),
      totalDeposited: String(currentDeposited + 1000),
    })
    .where(eq(users.id, dbUser.id));

  logger.info(
    "Successfully awarded 1,000 points to user",
    undefined,
    "OnboardingOnchain",
  );

  // Generate referral code for new user (ensures they can refer others immediately)
  const services = getOnboardingServices();
  await services.getOrCreateReferralCode(dbUser.id);

  await services.notifyNewAccount(dbUser.id);
  logger.info(
    "Welcome notification sent to new user",
    { userId: dbUser.id },
    "OnboardingOnchain",
  );

  if (referrerId) {
    const services = getOnboardingServices();
    // Award points to REFERRER
    const referralResult = await services.pointsService.awardReferralSignup(
      referrerId,
      dbUser.id,
    );

    // Only proceed with referral rewards if referrer was successfully awarded
    if (referralResult.success) {
      // Award bonus to NEW USER (referee) for using referral code
      const refereeBonus = await services.pointsService.awardPoints(
        dbUser.id,
        POINTS.REFERRAL_BONUS,
        "referral_bonus",
        { referrerId },
      );

      if (referralCode) {
        // Create or update referral record (idempotent for retries)
        // Check if exists first
        const [existingReferral] = await db
          .select({ id: referrals.id })
          .from(referrals)
          .where(
            and(
              eq(referrals.referralCode, referralCode),
              eq(referrals.referredUserId, dbUser.id),
            ),
          )
          .limit(1);

        if (existingReferral) {
          await db
            .update(referrals)
            .set({
              status: "completed",
              completedAt: new Date(),
            })
            .where(eq(referrals.id, existingReferral.id));
        } else {
          await db.insert(referrals).values({
            id: await generateSnowflakeId(),
            referrerId,
            referralCode,
            referredUserId: dbUser.id,
            status: "completed",
            completedAt: new Date(),
            createdAt: new Date(),
          });
        }
      }

      // Check if follow exists first
      const [existingFollow] = await db
        .select({ id: follows.id })
        .from(follows)
        .where(
          and(
            eq(follows.followerId, dbUser.id),
            eq(follows.followingId, referrerId),
          ),
        )
        .limit(1);

      if (!existingFollow) {
        await db.insert(follows).values({
          id: await generateSnowflakeId(),
          followerId: dbUser.id,
          followingId: referrerId,
          createdAt: new Date(),
        });
      }

      logger.info(
        "New user auto-followed referrer",
        { referrerId, referredUserId: dbUser.id },
        "OnboardingOnchain",
      );
      logger.info(
        "Awarded referral points to both referrer and referee",
        {
          referrerId,
          referredUserId: dbUser.id,
          referrerPoints: referralResult.pointsAwarded,
          refereeBonus: refereeBonus.pointsAwarded,
        },
        "OnboardingOnchain",
      );
    } else {
      // Referral was blocked (self-referral, weekly limit, etc.)
      // Update referral status to rejected
      if (referralCode) {
        // Check if referral exists first
        const [existingRejectedReferral] = await db
          .select({ id: referrals.id })
          .from(referrals)
          .where(
            and(
              eq(referrals.referralCode, referralCode),
              eq(referrals.referredUserId, dbUser.id),
            ),
          )
          .limit(1);

        if (existingRejectedReferral) {
          await db
            .update(referrals)
            .set({ status: "rejected" })
            .where(eq(referrals.id, existingRejectedReferral.id));
        } else {
          await db.insert(referrals).values({
            id: await generateSnowflakeId(),
            referrerId,
            referralCode,
            referredUserId: dbUser.id,
            status: "rejected",
            createdAt: new Date(),
          });
        }
      }

      logger.warn(
        "Referral blocked during onchain registration - referrer not rewarded",
        {
          referrerId,
          referredUserId: dbUser.id,
          error: referralResult.error,
        },
        "OnboardingOnchain",
      );
    }
  }

  return {
    message: `Successfully registered ${user.isAgent ? "agent" : "user"} on-chain`,
    tokenId,
    txHash: registrationTxHash ?? submittedTxHash,
    alreadyRegistered: false,
    pointsAwarded: 1000,
    userId: dbUser.id,
  };
}

export interface OnchainRegistrationStatus {
  isRegistered: boolean;
  tokenId: number | null;
  walletAddress: string | null;
  txHash: string | null;
  dbRegistered: boolean;
}

export interface ConfirmOnchainProfileUpdateInput {
  userId: string;
  walletAddress: string;
  txHash: `0x${string}`;
}

export interface ConfirmOnchainProfileUpdateResult {
  tokenId: number;
  endpoint: string;
  capabilitiesHash: `0x${string}`;
  metadata: StringRecord<JsonValue> | null;
}

export async function confirmOnchainProfileUpdate({
  userId,
  walletAddress,
  txHash,
}: ConfirmOnchainProfileUpdateInput): Promise<ConfirmOnchainProfileUpdateResult> {
  if (!walletAddress) {
    throw new BusinessLogicError(
      "Wallet address required for profile update confirmation",
      "WALLET_REQUIRED",
    );
  }

  const lowerWallet = walletAddress.toLowerCase();
  const chainId = Number(process.env.NEXT_PUBLIC_CHAIN_ID || 31337);
  const publicClient = createPublicClient({
    chain: chainId === 31337 ? foundry : baseSepolia,
    transport: http(getRpcUrl()),
  });

  const receipt = await publicClient.waitForTransactionReceipt({
    hash: txHash,
    confirmations: 1,
  });

  if (receipt.status !== "success") {
    throw new BusinessLogicError(
      "Blockchain profile update transaction failed",
      "PROFILE_UPDATE_TX_FAILED",
      { txHash, userId, receipt: receipt.status },
    );
  }

  // Get the expected token ID for this user's wallet address
  const expectedTokenId = Number(
    await publicClient.readContract({
      address: IDENTITY_REGISTRY,
      abi: identityRegistryAbi,
      functionName: "getTokenId",
      args: [walletAddress as Address],
    }),
  );

  if (!expectedTokenId || Number.isNaN(expectedTokenId)) {
    throw new BusinessLogicError(
      "User wallet is not registered on-chain",
      "WALLET_NOT_REGISTERED",
      { walletAddress: lowerWallet },
    );
  }

  // Parse the transaction to find the AgentUpdated event and verify it updates the correct token
  let tokenId: number | null = null;
  let endpoint = "";
  let capabilitiesHash =
    "0x0000000000000000000000000000000000000000000000000000000000000000" as `0x${string}`;

  for (const log of receipt.logs) {
    // Skip logs that aren't from our contract or don't have enough topics
    if (log.address.toLowerCase() !== IDENTITY_REGISTRY.toLowerCase()) {
      continue;
    }
    if (log.topics.length === 0) {
      continue;
    }

    const decoded = decodeEventLog({
      abi: identityRegistryAbi,
      data: log.data,
      topics: log.topics,
      strict: false,
    });

    if (decoded.eventName === "AgentUpdated") {
      tokenId = Number(decoded.args.tokenId);
      endpoint = decoded.args.endpoint ?? "";
      capabilitiesHash = decoded.args.capabilitiesHash as `0x${string}`;
      break;
    }
  }

  // Verify that the transaction updated the correct token ID
  if (!tokenId) {
    throw new BusinessLogicError(
      "Transaction did not emit AgentUpdated event",
      "PROFILE_UPDATE_EVENT_NOT_FOUND",
      { txHash },
    );
  }

  if (tokenId !== expectedTokenId) {
    throw new BusinessLogicError(
      "Transaction updated a different token ID than expected",
      "PROFILE_UPDATE_TOKEN_MISMATCH",
      {
        txHash,
        expectedTokenId,
        actualTokenId: tokenId,
        walletAddress: lowerWallet,
      },
    );
  }

  const profile = await publicClient.readContract({
    address: IDENTITY_REGISTRY,
    abi: IDENTITY_REGISTRY_ABI,
    functionName: "getAgentProfile",
    args: [BigInt(tokenId)],
  });

  // Profile is returned as a tuple from the contract - type assertion is safe based on ABI
  const profileArray = profile as [
    string, // name
    string, // endpoint
    `0x${string}`, // capabilitiesHash
    bigint, // registeredAt
    boolean, // isActive
    string, // metadata
  ];
  endpoint = endpoint || profileArray[1];
  capabilitiesHash = profileArray[2];
  const rawMetadata = profileArray[5];

  let metadata: StringRecord<JsonValue> | null = null;
  if (typeof rawMetadata === "string" && rawMetadata.trim().length > 0) {
    metadata = JSON.parse(rawMetadata) as StringRecord<JsonValue>;
  }

  return {
    tokenId,
    endpoint,
    capabilitiesHash,
    metadata,
  };
}

export async function getOnchainRegistrationStatus(
  user: AuthenticatedUser,
): Promise<OnchainRegistrationStatus> {
  // Case-insensitive username lookup for agents
  const [userRecord] = user.isAgent
    ? await db
        .select({
          walletAddress: users.walletAddress,
          onChainRegistered: users.onChainRegistered,
          nftTokenId: users.nftTokenId,
          registrationTxHash: users.registrationTxHash,
        })
        .from(users)
        .where(sql`lower(${users.username}) = lower(${user.userId})`)
        .limit(1)
    : await db
        .select({
          walletAddress: users.walletAddress,
          onChainRegistered: users.onChainRegistered,
          nftTokenId: users.nftTokenId,
          registrationTxHash: users.registrationTxHash,
        })
        .from(users)
        .where(eq(users.id, user.userId))
        .limit(1);

  if (!userRecord) {
    logger.info(
      "Registration status checked (no user record)",
      { userId: user.userId },
      "OnboardingOnchain",
    );
    return {
      isRegistered: false,
      tokenId: null,
      walletAddress: null,
      txHash: null,
      dbRegistered: false,
    };
  }

  let tokenId = userRecord.nftTokenId;
  let isRegistered = Boolean(userRecord.onChainRegistered && tokenId !== null);

  const chainId = Number(process.env.NEXT_PUBLIC_CHAIN_ID || 31337);

  // Local development - skip blockchain calls, use database state
  // On testnets/mainnet, verify against the chain
  if (!user.isAgent && userRecord.walletAddress && chainId !== 31337) {
    const publicClient = createPublicClient({
      chain: baseSepolia,
      transport: http(getRpcUrl()),
    });

    const onchainRegistered = await publicClient.readContract({
      address: IDENTITY_REGISTRY,
      abi: identityRegistryAbi,
      functionName: "isRegistered",
      args: [userRecord.walletAddress as Address],
    });

    if (onchainRegistered && !tokenId) {
      const queriedTokenId = await publicClient.readContract({
        address: IDENTITY_REGISTRY,
        abi: identityRegistryAbi,
        functionName: "getTokenId",
        args: [userRecord.walletAddress as Address],
      });
      tokenId = Number(queriedTokenId);
    }

    isRegistered = onchainRegistered;
  }

  logger.info(
    "Registration status checked",
    {
      userId: user.userId,
      isRegistered,
      tokenId,
      dbRegistered: userRecord.onChainRegistered,
    },
    "OnboardingOnchain",
  );

  return {
    isRegistered,
    tokenId: tokenId ?? null,
    walletAddress: userRecord.walletAddress ?? null,
    txHash: userRecord.registrationTxHash ?? null,
    dbRegistered: userRecord.onChainRegistered,
  };
}
