CREATE TYPE "public"."AgentStatus" AS ENUM('REGISTERED', 'INITIALIZED', 'ACTIVE', 'PAUSED', 'TERMINATED');--> statement-breakpoint
CREATE TYPE "public"."AgentType" AS ENUM('USER_CONTROLLED', 'NPC', 'EXTERNAL');--> statement-breakpoint
CREATE TYPE "public"."OnboardingStatus" AS ENUM('PENDING_PROFILE', 'PENDING_ONCHAIN', 'ONCHAIN_IN_PROGRESS', 'ONCHAIN_FAILED', 'COMPLETED');--> statement-breakpoint
CREATE TYPE "public"."RealtimeOutboxStatus" AS ENUM('pending', 'sent', 'failed');--> statement-breakpoint
CREATE TABLE "ActorState" (
	"id" text PRIMARY KEY NOT NULL,
	"tradingBalance" numeric(18, 2) DEFAULT '10000' NOT NULL,
	"reputationPoints" integer DEFAULT 10000 NOT NULL,
	"hasPool" boolean DEFAULT false NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ActorFollow" (
	"id" text PRIMARY KEY NOT NULL,
	"followerId" text NOT NULL,
	"followingId" text NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"isMutual" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ActorRelationship" (
	"id" text PRIMARY KEY NOT NULL,
	"actor1Id" text NOT NULL,
	"actor2Id" text NOT NULL,
	"relationshipType" text NOT NULL,
	"strength" double precision NOT NULL,
	"sentiment" double precision NOT NULL,
	"isPublic" boolean DEFAULT true NOT NULL,
	"history" text,
	"affects" json,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp NOT NULL,
	"lastInteraction" timestamp,
	"interactionCount" integer DEFAULT 0 NOT NULL,
	"evolutionCount" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "NPCInteraction" (
	"id" text PRIMARY KEY NOT NULL,
	"actor1Id" text NOT NULL,
	"actor2Id" text NOT NULL,
	"interactionType" text NOT NULL,
	"sentiment" double precision DEFAULT 0 NOT NULL,
	"context" text NOT NULL,
	"metadata" json,
	"timestamp" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "NPCTrade" (
	"id" text PRIMARY KEY NOT NULL,
	"npcActorId" text NOT NULL,
	"poolId" text,
	"marketType" text NOT NULL,
	"ticker" text,
	"marketId" text,
	"action" text NOT NULL,
	"side" text,
	"amount" double precision NOT NULL,
	"price" double precision NOT NULL,
	"sentiment" double precision,
	"reason" text,
	"postId" text,
	"executedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "AgentCapability" (
	"id" text PRIMARY KEY NOT NULL,
	"agentRegistryId" text NOT NULL,
	"strategies" text[] DEFAULT '{}' NOT NULL,
	"markets" text[] DEFAULT '{}' NOT NULL,
	"actions" text[] DEFAULT '{}' NOT NULL,
	"version" text DEFAULT '1.0.0' NOT NULL,
	"x402Support" boolean DEFAULT false NOT NULL,
	"platform" text,
	"userType" text,
	"gameNetworkChainId" integer,
	"gameNetworkRpcUrl" text,
	"gameNetworkExplorerUrl" text,
	"skills" text[] DEFAULT '{}' NOT NULL,
	"domains" text[] DEFAULT '{}' NOT NULL,
	"a2aEndpoint" text,
	"mcpEndpoint" text,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp NOT NULL,
	CONSTRAINT "AgentCapability_agentRegistryId_unique" UNIQUE("agentRegistryId")
);
--> statement-breakpoint
CREATE TABLE "AgentGoalAction" (
	"id" text PRIMARY KEY NOT NULL,
	"goalId" text NOT NULL,
	"agentUserId" text NOT NULL,
	"actionType" text NOT NULL,
	"actionId" text,
	"impact" double precision NOT NULL,
	"metadata" json,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "AgentGoal" (
	"id" text PRIMARY KEY NOT NULL,
	"agentUserId" text NOT NULL,
	"type" text NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"target" json,
	"priority" integer NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"progress" double precision DEFAULT 0 NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp NOT NULL,
	"completedAt" timestamp
);
--> statement-breakpoint
CREATE TABLE "AgentLog" (
	"id" text PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"level" text NOT NULL,
	"message" text NOT NULL,
	"prompt" text,
	"completion" text,
	"thinking" text,
	"metadata" json,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"agentUserId" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "AgentMessage" (
	"id" text PRIMARY KEY NOT NULL,
	"role" text NOT NULL,
	"content" text NOT NULL,
	"modelUsed" text,
	"pointsCost" integer DEFAULT 0 NOT NULL,
	"metadata" json,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"agentUserId" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "AgentPerformanceMetrics" (
	"id" text PRIMARY KEY NOT NULL,
	"userId" text NOT NULL,
	"gamesPlayed" integer DEFAULT 0 NOT NULL,
	"gamesWon" integer DEFAULT 0 NOT NULL,
	"averageGameScore" double precision DEFAULT 0 NOT NULL,
	"lastGameScore" double precision,
	"lastGamePlayedAt" timestamp,
	"normalizedPnL" double precision DEFAULT 0.5 NOT NULL,
	"totalTrades" integer DEFAULT 0 NOT NULL,
	"profitableTrades" integer DEFAULT 0 NOT NULL,
	"winRate" double precision DEFAULT 0 NOT NULL,
	"averageROI" double precision DEFAULT 0 NOT NULL,
	"sharpeRatio" double precision,
	"totalFeedbackCount" integer DEFAULT 0 NOT NULL,
	"averageFeedbackScore" double precision DEFAULT 70 NOT NULL,
	"intelFeedbackCount" integer DEFAULT 0 NOT NULL,
	"averageIntelScore" double precision DEFAULT 50 NOT NULL,
	"averageRating" double precision,
	"positiveCount" integer DEFAULT 0 NOT NULL,
	"neutralCount" integer DEFAULT 0 NOT NULL,
	"negativeCount" integer DEFAULT 0 NOT NULL,
	"reputationScore" double precision DEFAULT 70 NOT NULL,
	"trustLevel" text DEFAULT 'UNRATED' NOT NULL,
	"confidenceScore" double precision DEFAULT 0 NOT NULL,
	"onChainReputationSync" boolean DEFAULT false NOT NULL,
	"lastSyncedAt" timestamp,
	"onChainTrustScore" double precision,
	"onChainAccuracyScore" double precision,
	"firstActivityAt" timestamp,
	"lastActivityAt" timestamp,
	"totalInteractions" integer DEFAULT 0 NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp NOT NULL,
	CONSTRAINT "AgentPerformanceMetrics_userId_unique" UNIQUE("userId")
);
--> statement-breakpoint
CREATE TABLE "AgentPointsTransaction" (
	"id" text PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"amount" integer NOT NULL,
	"balanceBefore" integer NOT NULL,
	"balanceAfter" integer NOT NULL,
	"description" text NOT NULL,
	"relatedId" text,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"agentUserId" text NOT NULL,
	"managerUserId" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "AgentRegistry" (
	"id" text PRIMARY KEY NOT NULL,
	"agentId" text NOT NULL,
	"type" "AgentType" NOT NULL,
	"status" "AgentStatus" DEFAULT 'REGISTERED' NOT NULL,
	"trustLevel" integer DEFAULT 0 NOT NULL,
	"userId" text,
	"actorId" text,
	"name" text NOT NULL,
	"systemPrompt" text NOT NULL,
	"discoveryCardVersion" text,
	"discoveryEndpointA2a" text,
	"discoveryEndpointMcp" text,
	"discoveryEndpointRpc" text,
	"discoveryAuthRequired" boolean DEFAULT false NOT NULL,
	"discoveryAuthMethods" text[] DEFAULT '{}' NOT NULL,
	"discoveryRateLimit" integer,
	"discoveryCostPerAction" double precision,
	"onChainTokenId" integer,
	"onChainTxHash" text,
	"onChainServerWallet" text,
	"onChainReputationScore" integer DEFAULT 0,
	"onChainChainId" integer,
	"onChainIdentityRegistry" text,
	"onChainReputationSystem" text,
	"agent0TokenId" text,
	"agent0MetadataCID" text,
	"agent0SubgraphOwner" text,
	"agent0SubgraphMetadataURI" text,
	"agent0SubgraphTimestamp" integer,
	"agent0DiscoveryEndpoint" text,
	"runtimeInstanceId" text,
	"registeredAt" timestamp DEFAULT now() NOT NULL,
	"lastActiveAt" timestamp,
	"terminatedAt" timestamp,
	"updatedAt" timestamp NOT NULL,
	CONSTRAINT "AgentRegistry_agentId_unique" UNIQUE("agentId"),
	CONSTRAINT "AgentRegistry_userId_unique" UNIQUE("userId"),
	CONSTRAINT "AgentRegistry_actorId_unique" UNIQUE("actorId"),
	CONSTRAINT "AgentRegistry_runtimeInstanceId_unique" UNIQUE("runtimeInstanceId")
);
--> statement-breakpoint
CREATE TABLE "AgentTrade" (
	"id" text PRIMARY KEY NOT NULL,
	"marketType" text NOT NULL,
	"marketId" text,
	"ticker" text,
	"action" text NOT NULL,
	"side" text,
	"amount" double precision NOT NULL,
	"price" double precision NOT NULL,
	"pnl" double precision,
	"reasoning" text,
	"executedAt" timestamp DEFAULT now() NOT NULL,
	"agentUserId" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ExternalAgentConnection" (
	"id" text PRIMARY KEY NOT NULL,
	"agentRegistryId" text NOT NULL,
	"externalId" text NOT NULL,
	"endpoint" text NOT NULL,
	"protocol" text NOT NULL,
	"authType" text,
	"authCredentials" text,
	"agentCardJson" json,
	"isHealthy" boolean DEFAULT true NOT NULL,
	"lastHealthCheck" timestamp,
	"lastConnected" timestamp,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp NOT NULL,
	CONSTRAINT "ExternalAgentConnection_agentRegistryId_unique" UNIQUE("agentRegistryId"),
	CONSTRAINT "ExternalAgentConnection_externalId_unique" UNIQUE("externalId")
);
--> statement-breakpoint
CREATE TABLE "Market" (
	"id" text PRIMARY KEY NOT NULL,
	"question" text NOT NULL,
	"description" text,
	"gameId" text,
	"dayNumber" integer,
	"yesShares" numeric(18, 6) DEFAULT '0' NOT NULL,
	"noShares" numeric(18, 6) DEFAULT '0' NOT NULL,
	"liquidity" numeric(18, 6) NOT NULL,
	"resolved" boolean DEFAULT false NOT NULL,
	"resolution" boolean,
	"endDate" timestamp NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp NOT NULL,
	"onChainMarketId" text,
	"onChainResolutionTxHash" text,
	"onChainResolved" boolean DEFAULT false NOT NULL,
	"oracleAddress" text,
	"resolutionProofUrl" text,
	"resolutionDescription" text
);
--> statement-breakpoint
CREATE TABLE "Organization" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"ticker" text,
	"description" text NOT NULL,
	"type" text NOT NULL,
	"canBeInvolved" boolean DEFAULT true NOT NULL,
	"initialPrice" double precision,
	"currentPrice" double precision,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp NOT NULL,
	"imageUrl" text
);
--> statement-breakpoint
CREATE TABLE "PerpMarketSnapshot" (
	"ticker" text PRIMARY KEY NOT NULL,
	"organizationId" text NOT NULL,
	"name" text,
	"currentPrice" double precision NOT NULL,
	"price24hAgo" double precision,
	"price24hAgoUpdatedAt" timestamp,
	"metrics24hResetAt" timestamp,
	"change24h" double precision DEFAULT 0 NOT NULL,
	"changePercent24h" double precision DEFAULT 0 NOT NULL,
	"high24h" double precision NOT NULL,
	"low24h" double precision NOT NULL,
	"volume24h" double precision DEFAULT 0 NOT NULL,
	"openInterest" double precision DEFAULT 0 NOT NULL,
	"fundingRate" jsonb NOT NULL,
	"maxLeverage" integer DEFAULT 100 NOT NULL,
	"minOrderSize" integer DEFAULT 10 NOT NULL,
	"markPrice" double precision,
	"indexPrice" double precision,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "PerpPosition" (
	"id" text PRIMARY KEY NOT NULL,
	"userId" text NOT NULL,
	"ticker" text NOT NULL,
	"organizationId" text NOT NULL,
	"side" text NOT NULL,
	"entryPrice" double precision NOT NULL,
	"currentPrice" double precision NOT NULL,
	"size" double precision NOT NULL,
	"leverage" integer NOT NULL,
	"liquidationPrice" double precision NOT NULL,
	"unrealizedPnL" double precision NOT NULL,
	"unrealizedPnLPercent" double precision NOT NULL,
	"fundingPaid" double precision DEFAULT 0 NOT NULL,
	"openedAt" timestamp DEFAULT now() NOT NULL,
	"lastUpdated" timestamp NOT NULL,
	"closedAt" timestamp,
	"realizedPnL" double precision,
	"settledAt" timestamp,
	"settledToChain" boolean DEFAULT false NOT NULL,
	"settlementTxHash" text
);
--> statement-breakpoint
CREATE TABLE "Position" (
	"id" text PRIMARY KEY NOT NULL,
	"userId" text NOT NULL,
	"marketId" text NOT NULL,
	"side" boolean NOT NULL,
	"shares" numeric(18, 6) NOT NULL,
	"avgPrice" numeric(18, 6) NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp NOT NULL,
	"amount" numeric(18, 2) DEFAULT '0' NOT NULL,
	"outcome" boolean,
	"pnl" numeric(18, 2),
	"questionId" integer,
	"resolvedAt" timestamp,
	"status" text DEFAULT 'active' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "PredictionPriceHistory" (
	"id" text PRIMARY KEY NOT NULL,
	"marketId" text NOT NULL,
	"yesPrice" double precision NOT NULL,
	"noPrice" double precision NOT NULL,
	"yesShares" numeric(24, 8) NOT NULL,
	"noShares" numeric(24, 8) NOT NULL,
	"liquidity" numeric(24, 8) NOT NULL,
	"eventType" text NOT NULL,
	"source" text NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "Question" (
	"id" text PRIMARY KEY NOT NULL,
	"questionNumber" integer NOT NULL,
	"text" text NOT NULL,
	"scenarioId" integer NOT NULL,
	"outcome" boolean NOT NULL,
	"rank" integer NOT NULL,
	"createdDate" timestamp DEFAULT now() NOT NULL,
	"resolutionDate" timestamp NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"resolvedOutcome" boolean,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp NOT NULL,
	"oracleCommitBlock" integer,
	"oracleCommitTxHash" text,
	"oracleCommitment" text,
	"oracleError" text,
	"oraclePublishedAt" timestamp,
	"oracleRevealBlock" integer,
	"oracleRevealTxHash" text,
	"oracleSaltEncrypted" text,
	"oracleSessionId" text,
	"resolutionProofUrl" text,
	"resolutionDescription" text,
	CONSTRAINT "Question_questionNumber_unique" UNIQUE("questionNumber"),
	CONSTRAINT "Question_oracleSessionId_unique" UNIQUE("oracleSessionId")
);
--> statement-breakpoint
CREATE TABLE "StockPrice" (
	"id" text PRIMARY KEY NOT NULL,
	"organizationId" text NOT NULL,
	"price" double precision NOT NULL,
	"change" double precision NOT NULL,
	"changePercent" double precision NOT NULL,
	"timestamp" timestamp DEFAULT now() NOT NULL,
	"isSnapshot" boolean DEFAULT false NOT NULL,
	"openPrice" double precision,
	"highPrice" double precision,
	"lowPrice" double precision,
	"volume" double precision
);
--> statement-breakpoint
CREATE TABLE "ChatAdmin" (
	"id" text PRIMARY KEY NOT NULL,
	"chatId" text NOT NULL,
	"userId" text NOT NULL,
	"grantedAt" timestamp DEFAULT now() NOT NULL,
	"grantedBy" text NOT NULL,
	CONSTRAINT "ChatAdmin_chatId_userId_key" UNIQUE("chatId","userId")
);
--> statement-breakpoint
CREATE TABLE "ChatInvite" (
	"id" text PRIMARY KEY NOT NULL,
	"chatId" text NOT NULL,
	"invitedUserId" text NOT NULL,
	"invitedBy" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"message" text,
	"invitedAt" timestamp DEFAULT now() NOT NULL,
	"respondedAt" timestamp,
	CONSTRAINT "ChatInvite_chatId_invitedUserId_key" UNIQUE("chatId","invitedUserId")
);
--> statement-breakpoint
CREATE TABLE "ChatParticipant" (
	"id" text PRIMARY KEY NOT NULL,
	"chatId" text NOT NULL,
	"userId" text NOT NULL,
	"joinedAt" timestamp DEFAULT now() NOT NULL,
	"invitedBy" text,
	"isActive" boolean DEFAULT true NOT NULL,
	"lastMessageAt" timestamp,
	"messageCount" integer DEFAULT 0 NOT NULL,
	"qualityScore" double precision DEFAULT 1 NOT NULL,
	"kickedAt" timestamp,
	"kickReason" text,
	"addedBy" text,
	CONSTRAINT "ChatParticipant_chatId_userId_key" UNIQUE("chatId","userId")
);
--> statement-breakpoint
CREATE TABLE "Chat" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text,
	"description" text,
	"isGroup" boolean DEFAULT false NOT NULL,
	"createdBy" text,
	"npcAdminId" text,
	"gameId" text,
	"dayNumber" integer,
	"relatedQuestion" integer,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp NOT NULL,
	"groupId" text
);
--> statement-breakpoint
CREATE TABLE "DMAcceptance" (
	"id" text PRIMARY KEY NOT NULL,
	"chatId" text NOT NULL,
	"userId" text NOT NULL,
	"otherUserId" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"acceptedAt" timestamp,
	"rejectedAt" timestamp,
	CONSTRAINT "DMAcceptance_chatId_unique" UNIQUE("chatId")
);
--> statement-breakpoint
CREATE TABLE "GroupChatMembership" (
	"id" text PRIMARY KEY NOT NULL,
	"userId" text NOT NULL,
	"chatId" text NOT NULL,
	"npcAdminId" text NOT NULL,
	"joinedAt" timestamp DEFAULT now() NOT NULL,
	"lastMessageAt" timestamp,
	"messageCount" integer DEFAULT 0 NOT NULL,
	"qualityScore" double precision DEFAULT 1 NOT NULL,
	"isActive" boolean DEFAULT true NOT NULL,
	"sweepReason" text,
	"removedAt" timestamp,
	CONSTRAINT "GroupChatMembership_userId_chatId_key" UNIQUE("userId","chatId")
);
--> statement-breakpoint
CREATE TABLE "Message" (
	"id" text PRIMARY KEY NOT NULL,
	"chatId" text NOT NULL,
	"senderId" text NOT NULL,
	"content" text NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "Notification" (
	"id" text PRIMARY KEY NOT NULL,
	"userId" text NOT NULL,
	"type" text NOT NULL,
	"actorId" text,
	"postId" text,
	"commentId" text,
	"chatId" text,
	"message" text NOT NULL,
	"read" boolean DEFAULT false NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"title" text NOT NULL,
	"groupId" text,
	"inviteId" text
);
--> statement-breakpoint
CREATE TABLE "UserGroupAdmin" (
	"id" text PRIMARY KEY NOT NULL,
	"groupId" text NOT NULL,
	"userId" text NOT NULL,
	"grantedAt" timestamp DEFAULT now() NOT NULL,
	"grantedBy" text NOT NULL,
	CONSTRAINT "UserGroupAdmin_groupId_userId_key" UNIQUE("groupId","userId")
);
--> statement-breakpoint
CREATE TABLE "UserGroupInvite" (
	"id" text PRIMARY KEY NOT NULL,
	"groupId" text NOT NULL,
	"invitedUserId" text NOT NULL,
	"invitedBy" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"invitedAt" timestamp DEFAULT now() NOT NULL,
	"respondedAt" timestamp,
	"message" text,
	CONSTRAINT "UserGroupInvite_groupId_invitedUserId_key" UNIQUE("groupId","invitedUserId")
);
--> statement-breakpoint
CREATE TABLE "UserGroupMember" (
	"id" text PRIMARY KEY NOT NULL,
	"groupId" text NOT NULL,
	"userId" text NOT NULL,
	"joinedAt" timestamp DEFAULT now() NOT NULL,
	"addedBy" text NOT NULL,
	CONSTRAINT "UserGroupMember_groupId_userId_key" UNIQUE("groupId","userId")
);
--> statement-breakpoint
CREATE TABLE "UserGroup" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"createdById" text NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "GameConfig" (
	"id" text PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"value" json NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp NOT NULL,
	CONSTRAINT "GameConfig_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "Game" (
	"id" text PRIMARY KEY NOT NULL,
	"currentDay" integer DEFAULT 1 NOT NULL,
	"currentDate" timestamp DEFAULT now() NOT NULL,
	"isRunning" boolean DEFAULT false NOT NULL,
	"isContinuous" boolean DEFAULT true NOT NULL,
	"speed" integer DEFAULT 60000 NOT NULL,
	"startedAt" timestamp,
	"pausedAt" timestamp,
	"completedAt" timestamp,
	"lastTickAt" timestamp,
	"lastSnapshotAt" timestamp,
	"activeQuestions" integer DEFAULT 0 NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "GenerationLock" (
	"id" text PRIMARY KEY DEFAULT 'game-tick-lock' NOT NULL,
	"lockedBy" text NOT NULL,
	"lockedAt" timestamp DEFAULT now() NOT NULL,
	"expiresAt" timestamp NOT NULL,
	"operation" text DEFAULT 'game-tick' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "OAuthState" (
	"id" text PRIMARY KEY NOT NULL,
	"state" text NOT NULL,
	"codeVerifier" text NOT NULL,
	"userId" text,
	"returnPath" text,
	"expiresAt" timestamp NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "OAuthState_state_unique" UNIQUE("state")
);
--> statement-breakpoint
CREATE TABLE "OracleCommitment" (
	"id" text PRIMARY KEY NOT NULL,
	"questionId" text NOT NULL,
	"sessionId" text NOT NULL,
	"saltEncrypted" text NOT NULL,
	"commitment" text NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "OracleCommitment_questionId_unique" UNIQUE("questionId")
);
--> statement-breakpoint
CREATE TABLE "OracleTransaction" (
	"id" text PRIMARY KEY NOT NULL,
	"questionId" text,
	"txType" text NOT NULL,
	"txHash" text NOT NULL,
	"status" text NOT NULL,
	"blockNumber" integer,
	"gasUsed" bigint,
	"gasPrice" bigint,
	"error" text,
	"retryCount" integer DEFAULT 0 NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"confirmedAt" timestamp,
	CONSTRAINT "OracleTransaction_txHash_unique" UNIQUE("txHash")
);
--> statement-breakpoint
CREATE TABLE "ParodyHeadline" (
	"id" text PRIMARY KEY NOT NULL,
	"originalHeadlineId" text NOT NULL,
	"originalTitle" text NOT NULL,
	"originalSource" text NOT NULL,
	"parodyTitle" text NOT NULL,
	"parodyContent" text,
	"characterMappings" json NOT NULL,
	"organizationMappings" json NOT NULL,
	"generatedAt" timestamp NOT NULL,
	"isUsed" boolean DEFAULT false NOT NULL,
	"usedAt" timestamp,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "ParodyHeadline_originalHeadlineId_unique" UNIQUE("originalHeadlineId")
);
--> statement-breakpoint
CREATE TABLE "RealtimeOutbox" (
	"id" text PRIMARY KEY NOT NULL,
	"channel" text NOT NULL,
	"type" text NOT NULL,
	"version" text DEFAULT 'v1',
	"payload" json NOT NULL,
	"status" "RealtimeOutboxStatus" DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"lastError" text,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "RSSFeedSource" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"feedUrl" text NOT NULL,
	"category" text NOT NULL,
	"isActive" boolean DEFAULT true NOT NULL,
	"lastFetched" timestamp,
	"fetchErrors" integer DEFAULT 0 NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "RSSHeadline" (
	"id" text PRIMARY KEY NOT NULL,
	"sourceId" text NOT NULL,
	"title" text NOT NULL,
	"link" text,
	"publishedAt" timestamp NOT NULL,
	"summary" text,
	"content" text,
	"rawData" json,
	"fetchedAt" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "SystemSettings" (
	"id" text PRIMARY KEY DEFAULT 'system' NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "TickTokenStats" (
	"id" text PRIMARY KEY NOT NULL,
	"tickId" text NOT NULL,
	"tickStartedAt" timestamp NOT NULL,
	"tickCompletedAt" timestamp NOT NULL,
	"tickDurationMs" integer NOT NULL,
	"totalCalls" integer NOT NULL,
	"totalInputTokens" integer NOT NULL,
	"totalOutputTokens" integer NOT NULL,
	"totalTokens" integer NOT NULL,
	"byPromptType" json NOT NULL,
	"byModel" json NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "WidgetCache" (
	"widget" text PRIMARY KEY NOT NULL,
	"data" json NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "WorldEvent" (
	"id" text PRIMARY KEY NOT NULL,
	"eventType" text NOT NULL,
	"description" text NOT NULL,
	"actors" text[] DEFAULT '{}' NOT NULL,
	"relatedQuestion" integer,
	"pointsToward" text,
	"visibility" text DEFAULT 'public' NOT NULL,
	"gameId" text,
	"dayNumber" integer,
	"timestamp" timestamp DEFAULT now() NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "WorldFact" (
	"id" text PRIMARY KEY NOT NULL,
	"category" text NOT NULL,
	"key" text NOT NULL,
	"label" text NOT NULL,
	"value" text NOT NULL,
	"source" text,
	"lastUpdated" timestamp NOT NULL,
	"isActive" boolean DEFAULT true NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "QuestionArcPlan" (
	"id" text PRIMARY KEY NOT NULL,
	"questionId" text NOT NULL,
	"uncertaintyPeakDay" integer NOT NULL,
	"clarityOnsetDay" integer NOT NULL,
	"verificationDay" integer NOT NULL,
	"insiderActorIds" jsonb DEFAULT '[]'::jsonb,
	"deceiverActorIds" jsonb DEFAULT '[]'::jsonb,
	"phaseRatios" jsonb NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "OrganizationState" (
	"id" text PRIMARY KEY NOT NULL,
	"currentPrice" double precision,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "PoolDeposit" (
	"id" text PRIMARY KEY NOT NULL,
	"poolId" text NOT NULL,
	"userId" text NOT NULL,
	"amount" numeric(18, 2) NOT NULL,
	"shares" numeric(18, 6) NOT NULL,
	"currentValue" numeric(18, 2) NOT NULL,
	"unrealizedPnL" numeric(18, 2) NOT NULL,
	"depositedAt" timestamp DEFAULT now() NOT NULL,
	"withdrawnAt" timestamp,
	"withdrawnAmount" numeric(18, 2)
);
--> statement-breakpoint
CREATE TABLE "PoolPosition" (
	"id" text PRIMARY KEY NOT NULL,
	"poolId" text NOT NULL,
	"marketType" text NOT NULL,
	"ticker" text,
	"marketId" text,
	"side" text NOT NULL,
	"entryPrice" double precision NOT NULL,
	"currentPrice" double precision NOT NULL,
	"size" double precision NOT NULL,
	"shares" double precision,
	"leverage" integer,
	"liquidationPrice" double precision,
	"unrealizedPnL" double precision NOT NULL,
	"openedAt" timestamp DEFAULT now() NOT NULL,
	"closedAt" timestamp,
	"realizedPnL" double precision,
	"updatedAt" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "Pool" (
	"id" text PRIMARY KEY NOT NULL,
	"npcActorId" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"totalValue" numeric(18, 2) DEFAULT '0' NOT NULL,
	"totalDeposits" numeric(18, 2) DEFAULT '0' NOT NULL,
	"availableBalance" numeric(18, 2) DEFAULT '0' NOT NULL,
	"lifetimePnL" numeric(18, 2) DEFAULT '0' NOT NULL,
	"performanceFeeRate" double precision DEFAULT 0.05 NOT NULL,
	"totalFeesCollected" numeric(18, 2) DEFAULT '0' NOT NULL,
	"isActive" boolean DEFAULT true NOT NULL,
	"openedAt" timestamp DEFAULT now() NOT NULL,
	"closedAt" timestamp,
	"updatedAt" timestamp NOT NULL,
	"currentPrice" double precision,
	"priceChange24h" double precision,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"tvl" numeric(18, 2),
	"volume24h" numeric(18, 2)
);
--> statement-breakpoint
CREATE TABLE "Comment" (
	"id" text PRIMARY KEY NOT NULL,
	"content" text NOT NULL,
	"postId" text NOT NULL,
	"authorId" text NOT NULL,
	"parentCommentId" text,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp NOT NULL,
	"deletedAt" timestamp
);
--> statement-breakpoint
CREATE TABLE "PostTag" (
	"id" text PRIMARY KEY NOT NULL,
	"postId" text NOT NULL,
	"tagId" text NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "PostTag_postId_tagId_key" UNIQUE("postId","tagId")
);
--> statement-breakpoint
CREATE TABLE "Post" (
	"id" text PRIMARY KEY NOT NULL,
	"content" text NOT NULL,
	"authorId" text NOT NULL,
	"gameId" text,
	"dayNumber" integer,
	"timestamp" timestamp DEFAULT now() NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"articleTitle" text,
	"biasScore" double precision,
	"byline" text,
	"category" text,
	"fullContent" text,
	"sentiment" text,
	"slant" text,
	"type" text DEFAULT 'post' NOT NULL,
	"deletedAt" timestamp,
	"commentOnPostId" text,
	"parentCommentId" text,
	"originalPostId" text
);
--> statement-breakpoint
CREATE TABLE "Reaction" (
	"id" text PRIMARY KEY NOT NULL,
	"postId" text,
	"commentId" text,
	"userId" text NOT NULL,
	"type" text DEFAULT 'like' NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "Reaction_commentId_userId_type_key" UNIQUE("commentId","userId","type"),
	CONSTRAINT "Reaction_postId_userId_type_key" UNIQUE("postId","userId","type")
);
--> statement-breakpoint
CREATE TABLE "ShareAction" (
	"id" text PRIMARY KEY NOT NULL,
	"userId" text NOT NULL,
	"platform" text NOT NULL,
	"contentType" text NOT NULL,
	"contentId" text,
	"url" text,
	"pointsAwarded" boolean DEFAULT false NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"verificationDetails" text,
	"verified" boolean DEFAULT false NOT NULL,
	"verifiedAt" timestamp
);
--> statement-breakpoint
CREATE TABLE "Share" (
	"id" text PRIMARY KEY NOT NULL,
	"userId" text NOT NULL,
	"postId" text NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "Share_userId_postId_key" UNIQUE("userId","postId")
);
--> statement-breakpoint
CREATE TABLE "Tag" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"displayName" text NOT NULL,
	"category" text,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp NOT NULL,
	CONSTRAINT "Tag_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "TrendingTag" (
	"id" text PRIMARY KEY NOT NULL,
	"tagId" text NOT NULL,
	"score" double precision NOT NULL,
	"postCount" integer NOT NULL,
	"rank" integer NOT NULL,
	"calculatedAt" timestamp DEFAULT now() NOT NULL,
	"windowStart" timestamp NOT NULL,
	"windowEnd" timestamp NOT NULL,
	"relatedContext" text
);
--> statement-breakpoint
CREATE TABLE "BalanceTransaction" (
	"id" text PRIMARY KEY NOT NULL,
	"userId" text NOT NULL,
	"type" text NOT NULL,
	"amount" numeric(18, 2) NOT NULL,
	"balanceBefore" numeric(18, 2) NOT NULL,
	"balanceAfter" numeric(18, 2) NOT NULL,
	"relatedId" text,
	"description" text,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "Feedback" (
	"id" text PRIMARY KEY NOT NULL,
	"fromUserId" text,
	"fromAgentId" text,
	"toUserId" text,
	"toAgentId" text,
	"score" integer NOT NULL,
	"rating" integer,
	"comment" text,
	"category" text,
	"gameId" text,
	"tradeId" text,
	"positionId" text,
	"interactionType" text NOT NULL,
	"onChainTxHash" text,
	"agent0TokenId" integer,
	"metadata" json,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ModerationEscrow" (
	"id" text PRIMARY KEY NOT NULL,
	"recipientId" text NOT NULL,
	"adminId" text NOT NULL,
	"amountUSD" numeric(18, 2) NOT NULL,
	"amountWei" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"reason" text,
	"paymentRequestId" text,
	"paymentTxHash" text,
	"refundTxHash" text,
	"refundedBy" text,
	"refundedAt" timestamp,
	"metadata" json,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp NOT NULL,
	"expiresAt" timestamp NOT NULL,
	CONSTRAINT "ModerationEscrow_paymentRequestId_unique" UNIQUE("paymentRequestId"),
	CONSTRAINT "ModerationEscrow_paymentTxHash_unique" UNIQUE("paymentTxHash"),
	CONSTRAINT "ModerationEscrow_refundTxHash_unique" UNIQUE("refundTxHash")
);
--> statement-breakpoint
CREATE TABLE "PointsTransaction" (
	"id" text PRIMARY KEY NOT NULL,
	"userId" text NOT NULL,
	"amount" integer NOT NULL,
	"pointsBefore" integer NOT NULL,
	"pointsAfter" integer NOT NULL,
	"reason" text NOT NULL,
	"metadata" text,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"paymentAmount" text,
	"paymentRequestId" text,
	"paymentTxHash" text,
	"paymentVerified" boolean DEFAULT false NOT NULL,
	CONSTRAINT "PointsTransaction_paymentRequestId_unique" UNIQUE("paymentRequestId")
);
--> statement-breakpoint
CREATE TABLE "Report" (
	"id" text PRIMARY KEY NOT NULL,
	"reporterId" text NOT NULL,
	"reportedUserId" text,
	"reportedPostId" text,
	"reportType" text NOT NULL,
	"category" text NOT NULL,
	"reason" text NOT NULL,
	"evidence" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"priority" text DEFAULT 'normal' NOT NULL,
	"resolution" text,
	"resolvedBy" text,
	"resolvedAt" timestamp,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "TradingFee" (
	"id" text PRIMARY KEY NOT NULL,
	"userId" text NOT NULL,
	"tradeType" text NOT NULL,
	"tradeId" text,
	"marketId" text,
	"feeAmount" numeric(18, 2) NOT NULL,
	"platformFee" numeric(18, 2) NOT NULL,
	"referrerFee" numeric(18, 2) NOT NULL,
	"referrerId" text,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "benchmark_results" (
	"id" text PRIMARY KEY NOT NULL,
	"modelId" text NOT NULL,
	"benchmarkId" text NOT NULL,
	"benchmarkPath" text NOT NULL,
	"runAt" timestamp DEFAULT now() NOT NULL,
	"totalPnl" double precision NOT NULL,
	"predictionAccuracy" double precision NOT NULL,
	"perpWinRate" double precision NOT NULL,
	"optimalityScore" double precision NOT NULL,
	"detailedMetrics" json NOT NULL,
	"baselinePnlDelta" double precision,
	"baselineAccuracyDelta" double precision,
	"improved" boolean,
	"duration" integer NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "llm_call_logs" (
	"id" text PRIMARY KEY NOT NULL,
	"trajectoryId" text NOT NULL,
	"stepId" text NOT NULL,
	"callId" text NOT NULL,
	"timestamp" timestamp NOT NULL,
	"latencyMs" integer,
	"model" text NOT NULL,
	"purpose" text NOT NULL,
	"actionType" text,
	"systemPrompt" text NOT NULL,
	"userPrompt" text NOT NULL,
	"messagesJson" text,
	"response" text NOT NULL,
	"reasoning" text,
	"temperature" double precision NOT NULL,
	"maxTokens" integer NOT NULL,
	"topP" double precision,
	"promptTokens" integer,
	"completionTokens" integer,
	"totalTokens" integer,
	"metadata" text,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "llm_call_logs_callId_unique" UNIQUE("callId")
);
--> statement-breakpoint
CREATE TABLE "market_outcomes" (
	"id" text PRIMARY KEY NOT NULL,
	"windowId" varchar(50) NOT NULL,
	"stockTicker" varchar(20),
	"startPrice" numeric(10, 2),
	"endPrice" numeric(10, 2),
	"changePercent" numeric(5, 2),
	"sentiment" varchar(20),
	"newsEvents" json,
	"predictionMarketId" text,
	"question" text,
	"outcome" varchar(20),
	"finalProbability" numeric(5, 4),
	"volume" numeric(15, 2),
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reward_judgments" (
	"id" text PRIMARY KEY NOT NULL,
	"trajectoryId" text NOT NULL,
	"judgeModel" text NOT NULL,
	"judgeVersion" text NOT NULL,
	"overallScore" double precision NOT NULL,
	"componentScoresJson" text,
	"rank" integer,
	"normalizedScore" double precision,
	"groupId" text,
	"reasoning" text NOT NULL,
	"strengthsJson" text,
	"weaknessesJson" text,
	"criteriaJson" text NOT NULL,
	"judgedAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "reward_judgments_trajectoryId_unique" UNIQUE("trajectoryId")
);
--> statement-breakpoint
CREATE TABLE "trained_models" (
	"id" text PRIMARY KEY NOT NULL,
	"modelId" text NOT NULL,
	"version" text NOT NULL,
	"baseModel" text NOT NULL,
	"trainingBatch" text,
	"status" text DEFAULT 'training' NOT NULL,
	"deployedAt" timestamp,
	"archivedAt" timestamp,
	"storagePath" text NOT NULL,
	"benchmarkScore" double precision,
	"accuracy" double precision,
	"avgReward" double precision,
	"evalMetrics" json,
	"wandbRunId" text,
	"wandbArtifactId" text,
	"huggingFaceRepo" text,
	"agentsUsing" integer DEFAULT 0 NOT NULL,
	"totalInferences" integer DEFAULT 0 NOT NULL,
	"lastBenchmarked" timestamp,
	"benchmarkCount" integer DEFAULT 0 NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp NOT NULL,
	CONSTRAINT "trained_models_modelId_unique" UNIQUE("modelId")
);
--> statement-breakpoint
CREATE TABLE "training_batches" (
	"id" text PRIMARY KEY NOT NULL,
	"batchId" text NOT NULL,
	"scenarioId" text,
	"baseModel" text NOT NULL,
	"modelVersion" text NOT NULL,
	"trajectoryIds" text NOT NULL,
	"rankingsJson" text,
	"rewardsJson" text NOT NULL,
	"trainingLoss" double precision,
	"policyImprovement" double precision,
	"status" text DEFAULT 'pending' NOT NULL,
	"error" text,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"startedAt" timestamp,
	"completedAt" timestamp,
	CONSTRAINT "training_batches_batchId_unique" UNIQUE("batchId")
);
--> statement-breakpoint
CREATE TABLE "trajectories" (
	"id" text PRIMARY KEY NOT NULL,
	"trajectoryId" text NOT NULL,
	"agentId" text NOT NULL,
	"archetype" varchar(50),
	"startTime" timestamp NOT NULL,
	"endTime" timestamp NOT NULL,
	"durationMs" integer NOT NULL,
	"windowId" varchar(50),
	"windowHours" integer DEFAULT 1 NOT NULL,
	"episodeId" varchar(100),
	"scenarioId" varchar(100),
	"batchId" varchar(100),
	"stepsJson" text NOT NULL,
	"rewardComponentsJson" text NOT NULL,
	"metricsJson" text NOT NULL,
	"metadataJson" text NOT NULL,
	"totalReward" double precision NOT NULL,
	"episodeLength" integer NOT NULL,
	"finalStatus" text NOT NULL,
	"finalBalance" double precision,
	"finalPnL" double precision,
	"tradesExecuted" integer,
	"postsCreated" integer,
	"aiJudgeReward" double precision,
	"aiJudgeReasoning" text,
	"judgedAt" timestamp,
	"isTrainingData" boolean DEFAULT true NOT NULL,
	"isEvaluation" boolean DEFAULT false NOT NULL,
	"usedInTraining" boolean DEFAULT false NOT NULL,
	"trainedInBatch" text,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp NOT NULL,
	CONSTRAINT "trajectories_trajectoryId_unique" UNIQUE("trajectoryId")
);
--> statement-breakpoint
CREATE TABLE "UserAgentConfig" (
	"id" text PRIMARY KEY NOT NULL,
	"userId" text NOT NULL,
	"personality" text,
	"system" text,
	"tradingStrategy" text,
	"style" json,
	"messageExamples" json,
	"personaPrompt" text,
	"goals" json,
	"directives" json,
	"constraints" json,
	"planningHorizon" text DEFAULT 'single' NOT NULL,
	"riskTolerance" text DEFAULT 'medium' NOT NULL,
	"maxActionsPerTick" integer DEFAULT 3 NOT NULL,
	"modelTier" text DEFAULT 'free' NOT NULL,
	"autonomousPosting" boolean DEFAULT false NOT NULL,
	"autonomousCommenting" boolean DEFAULT false NOT NULL,
	"autonomousTrading" boolean DEFAULT false NOT NULL,
	"autonomousDMs" boolean DEFAULT false NOT NULL,
	"autonomousGroupChats" boolean DEFAULT false NOT NULL,
	"a2aEnabled" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'idle' NOT NULL,
	"errorMessage" text,
	"lastTickAt" timestamp,
	"lastChatAt" timestamp,
	"pointsBalance" integer DEFAULT 0 NOT NULL,
	"totalDeposited" integer DEFAULT 0 NOT NULL,
	"totalWithdrawn" integer DEFAULT 0 NOT NULL,
	"totalPointsSpent" integer DEFAULT 0 NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp NOT NULL,
	CONSTRAINT "UserAgentConfig_userId_unique" UNIQUE("userId")
);
--> statement-breakpoint
CREATE TABLE "Favorite" (
	"id" text PRIMARY KEY NOT NULL,
	"userId" text NOT NULL,
	"targetUserId" text NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "Favorite_userId_targetUserId_key" UNIQUE("userId","targetUserId")
);
--> statement-breakpoint
CREATE TABLE "FollowStatus" (
	"id" text PRIMARY KEY NOT NULL,
	"userId" text NOT NULL,
	"npcId" text NOT NULL,
	"followedAt" timestamp DEFAULT now() NOT NULL,
	"unfollowedAt" timestamp,
	"isActive" boolean DEFAULT true NOT NULL,
	"followReason" text,
	CONSTRAINT "FollowStatus_userId_npcId_key" UNIQUE("userId","npcId")
);
--> statement-breakpoint
CREATE TABLE "Follow" (
	"id" text PRIMARY KEY NOT NULL,
	"followerId" text NOT NULL,
	"followingId" text NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "Follow_followerId_followingId_key" UNIQUE("followerId","followingId")
);
--> statement-breakpoint
CREATE TABLE "OnboardingIntent" (
	"id" text PRIMARY KEY NOT NULL,
	"userId" text NOT NULL,
	"status" "OnboardingStatus" DEFAULT 'PENDING_PROFILE' NOT NULL,
	"referralCode" text,
	"payload" json,
	"profileApplied" boolean DEFAULT false NOT NULL,
	"profileCompletedAt" timestamp,
	"onchainStartedAt" timestamp,
	"onchainCompletedAt" timestamp,
	"lastError" json,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp NOT NULL,
	CONSTRAINT "OnboardingIntent_userId_unique" UNIQUE("userId")
);
--> statement-breakpoint
CREATE TABLE "ProfileUpdateLog" (
	"id" text PRIMARY KEY NOT NULL,
	"userId" text NOT NULL,
	"changedFields" text[] NOT NULL,
	"backendSigned" boolean NOT NULL,
	"txHash" text,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "Referral" (
	"id" text PRIMARY KEY NOT NULL,
	"referrerId" text NOT NULL,
	"referredUserId" text,
	"referralCode" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"completedAt" timestamp,
	"qualifiedAt" timestamp,
	"signupPointsAwarded" boolean DEFAULT false NOT NULL,
	"suspiciousReferralFlags" json,
	CONSTRAINT "Referral_referralCode_referredUserId_key" UNIQUE("referralCode","referredUserId")
);
--> statement-breakpoint
CREATE TABLE "TwitterOAuthToken" (
	"id" text PRIMARY KEY NOT NULL,
	"userId" text NOT NULL,
	"oauth1Token" text NOT NULL,
	"oauth1TokenSecret" text NOT NULL,
	"screenName" text,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp NOT NULL,
	CONSTRAINT "TwitterOAuthToken_userId_unique" UNIQUE("userId")
);
--> statement-breakpoint
CREATE TABLE "UserActorFollow" (
	"id" text PRIMARY KEY NOT NULL,
	"userId" text NOT NULL,
	"actorId" text NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "UserActorFollow_userId_actorId_key" UNIQUE("userId","actorId")
);
--> statement-breakpoint
CREATE TABLE "UserApiKey" (
	"id" text PRIMARY KEY NOT NULL,
	"userId" text NOT NULL,
	"keyHash" text NOT NULL,
	"name" text,
	"lastUsedAt" timestamp,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"expiresAt" timestamp,
	"revokedAt" timestamp
);
--> statement-breakpoint
CREATE TABLE "UserBlock" (
	"id" text PRIMARY KEY NOT NULL,
	"blockerId" text NOT NULL,
	"blockedId" text NOT NULL,
	"reason" text,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "UserBlock_blockerId_blockedId_key" UNIQUE("blockerId","blockedId")
);
--> statement-breakpoint
CREATE TABLE "UserInteraction" (
	"id" text PRIMARY KEY NOT NULL,
	"userId" text NOT NULL,
	"npcId" text NOT NULL,
	"postId" text NOT NULL,
	"commentId" text NOT NULL,
	"timestamp" timestamp DEFAULT now() NOT NULL,
	"qualityScore" double precision DEFAULT 1 NOT NULL,
	"wasFollowed" boolean DEFAULT false NOT NULL,
	"wasInvitedToChat" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "UserMute" (
	"id" text PRIMARY KEY NOT NULL,
	"muterId" text NOT NULL,
	"mutedId" text NOT NULL,
	"reason" text,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "UserMute_muterId_mutedId_key" UNIQUE("muterId","mutedId")
);
--> statement-breakpoint
CREATE TABLE "User" (
	"id" text PRIMARY KEY NOT NULL,
	"walletAddress" text,
	"username" text,
	"displayName" text,
	"bio" text,
	"profileImageUrl" text,
	"isActor" boolean DEFAULT false NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp NOT NULL,
	"personality" text,
	"postStyle" text,
	"postExample" text,
	"virtualBalance" numeric(18, 2) DEFAULT '1000' NOT NULL,
	"totalDeposited" numeric(18, 2) DEFAULT '1000' NOT NULL,
	"totalWithdrawn" numeric(18, 2) DEFAULT '0' NOT NULL,
	"lifetimePnL" numeric(18, 2) DEFAULT '0' NOT NULL,
	"profileComplete" boolean DEFAULT false NOT NULL,
	"hasProfileImage" boolean DEFAULT false NOT NULL,
	"hasUsername" boolean DEFAULT false NOT NULL,
	"hasBio" boolean DEFAULT false NOT NULL,
	"profileSetupCompletedAt" timestamp,
	"farcasterUsername" text,
	"hasFarcaster" boolean DEFAULT false NOT NULL,
	"hasTwitter" boolean DEFAULT false NOT NULL,
	"hasDiscord" boolean DEFAULT false NOT NULL,
	"nftTokenId" integer,
	"onChainRegistered" boolean DEFAULT false NOT NULL,
	"pointsAwardedForFarcaster" boolean DEFAULT false NOT NULL,
	"pointsAwardedForFarcasterFollow" boolean DEFAULT false NOT NULL,
	"pointsAwardedForProfile" boolean DEFAULT false NOT NULL,
	"pointsAwardedForProfileImage" boolean DEFAULT false NOT NULL,
	"pointsAwardedForTwitter" boolean DEFAULT false NOT NULL,
	"pointsAwardedForTwitterFollow" boolean DEFAULT false NOT NULL,
	"pointsAwardedForDiscord" boolean DEFAULT false NOT NULL,
	"pointsAwardedForDiscordJoin" boolean DEFAULT false NOT NULL,
	"pointsAwardedForUsername" boolean DEFAULT false NOT NULL,
	"pointsAwardedForWallet" boolean DEFAULT false NOT NULL,
	"pointsAwardedForReferralBonus" boolean DEFAULT false NOT NULL,
	"pointsAwardedForShare" boolean DEFAULT false NOT NULL,
	"pointsAwardedForPrivateGroup" boolean DEFAULT false NOT NULL,
	"pointsAwardedForPrivateChannel" boolean DEFAULT false NOT NULL,
	"referralCode" text,
	"referralCount" integer DEFAULT 0 NOT NULL,
	"referredBy" text,
	"registrationIpHash" text,
	"lastReferralIpHash" text,
	"registrationTxHash" text,
	"reputationPoints" integer DEFAULT 1000 NOT NULL,
	"twitterUsername" text,
	"bannerDismissCount" integer DEFAULT 0 NOT NULL,
	"bannerLastShown" timestamp,
	"coverImageUrl" text,
	"showFarcasterPublic" boolean DEFAULT true NOT NULL,
	"showTwitterPublic" boolean DEFAULT true NOT NULL,
	"showWalletPublic" boolean DEFAULT true NOT NULL,
	"usernameChangedAt" timestamp,
	"agent0FeedbackCount" integer,
	"agent0MetadataCID" text,
	"agent0RegisteredAt" timestamp,
	"agent0TokenId" integer,
	"agent0TrustScore" double precision,
	"bannedAt" timestamp,
	"bannedBy" text,
	"bannedReason" text,
	"farcasterDisplayName" text,
	"farcasterFid" text,
	"farcasterPfpUrl" text,
	"farcasterVerifiedAt" timestamp,
	"isAdmin" boolean DEFAULT false NOT NULL,
	"isBanned" boolean DEFAULT false NOT NULL,
	"isScammer" boolean DEFAULT false NOT NULL,
	"isCSAM" boolean DEFAULT false NOT NULL,
	"appealCount" integer DEFAULT 0 NOT NULL,
	"appealStaked" boolean DEFAULT false NOT NULL,
	"appealStakeAmount" numeric(18, 2),
	"appealStakeTxHash" text,
	"appealStatus" text,
	"appealSubmittedAt" timestamp,
	"appealReviewedAt" timestamp,
	"falsePositiveHistory" json,
	"privyId" text,
	"registrationBlockNumber" bigint,
	"registrationGasUsed" bigint,
	"registrationTimestamp" timestamp,
	"role" text,
	"totalFeesEarned" numeric(18, 2) DEFAULT '0' NOT NULL,
	"totalFeesPaid" numeric(18, 2) DEFAULT '0' NOT NULL,
	"twitterAccessToken" text,
	"twitterId" text,
	"twitterRefreshToken" text,
	"twitterTokenExpiresAt" timestamp,
	"twitterVerifiedAt" timestamp,
	"discordId" text,
	"discordUsername" text,
	"discordAccessToken" text,
	"discordRefreshToken" text,
	"discordTokenExpiresAt" timestamp,
	"discordVerifiedAt" timestamp,
	"tosAccepted" boolean DEFAULT false NOT NULL,
	"tosAcceptedAt" timestamp,
	"tosAcceptedVersion" text DEFAULT '2025-11-11',
	"privacyPolicyAccepted" boolean DEFAULT false NOT NULL,
	"privacyPolicyAcceptedAt" timestamp,
	"privacyPolicyAcceptedVersion" text DEFAULT '2025-11-11',
	"invitePoints" integer DEFAULT 0 NOT NULL,
	"earnedPoints" integer DEFAULT 0 NOT NULL,
	"bonusPoints" integer DEFAULT 0 NOT NULL,
	"waitlistPosition" integer,
	"waitlistJoinedAt" timestamp,
	"isWaitlistActive" boolean DEFAULT false NOT NULL,
	"isTest" boolean DEFAULT false NOT NULL,
	"pointsAwardedForEmail" boolean DEFAULT false NOT NULL,
	"emailVerified" boolean DEFAULT false NOT NULL,
	"email" text,
	"waitlistGraduatedAt" timestamp,
	"isAgent" boolean DEFAULT false NOT NULL,
	"managedBy" text,
	CONSTRAINT "User_walletAddress_unique" UNIQUE("walletAddress"),
	CONSTRAINT "User_username_unique" UNIQUE("username"),
	CONSTRAINT "User_nftTokenId_unique" UNIQUE("nftTokenId"),
	CONSTRAINT "User_referralCode_unique" UNIQUE("referralCode"),
	CONSTRAINT "User_farcasterFid_unique" UNIQUE("farcasterFid"),
	CONSTRAINT "User_privyId_unique" UNIQUE("privyId"),
	CONSTRAINT "User_twitterId_unique" UNIQUE("twitterId"),
	CONSTRAINT "User_discordId_unique" UNIQUE("discordId")
);
--> statement-breakpoint
ALTER TABLE "QuestionArcPlan" ADD CONSTRAINT "QuestionArcPlan_questionId_Question_id_fk" FOREIGN KEY ("questionId") REFERENCES "public"."Question"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ActorState_hasPool_idx" ON "ActorState" USING btree ("hasPool");--> statement-breakpoint
CREATE INDEX "ActorState_reputationPoints_idx" ON "ActorState" USING btree ("reputationPoints");--> statement-breakpoint
CREATE INDEX "ActorFollow_followerId_idx" ON "ActorFollow" USING btree ("followerId");--> statement-breakpoint
CREATE INDEX "ActorFollow_followingId_idx" ON "ActorFollow" USING btree ("followingId");--> statement-breakpoint
CREATE INDEX "ActorFollow_isMutual_idx" ON "ActorFollow" USING btree ("isMutual");--> statement-breakpoint
CREATE INDEX "ActorRelationship_actor1Id_idx" ON "ActorRelationship" USING btree ("actor1Id");--> statement-breakpoint
CREATE INDEX "ActorRelationship_actor2Id_idx" ON "ActorRelationship" USING btree ("actor2Id");--> statement-breakpoint
CREATE INDEX "ActorRelationship_relationshipType_idx" ON "ActorRelationship" USING btree ("relationshipType");--> statement-breakpoint
CREATE INDEX "ActorRelationship_sentiment_idx" ON "ActorRelationship" USING btree ("sentiment");--> statement-breakpoint
CREATE INDEX "ActorRelationship_strength_idx" ON "ActorRelationship" USING btree ("strength");--> statement-breakpoint
CREATE INDEX "ActorRelationship_lastInteraction_idx" ON "ActorRelationship" USING btree ("lastInteraction");--> statement-breakpoint
CREATE INDEX "NPCInteraction_actor1Id_actor2Id_timestamp_idx" ON "NPCInteraction" USING btree ("actor1Id","actor2Id","timestamp");--> statement-breakpoint
CREATE INDEX "NPCInteraction_timestamp_idx" ON "NPCInteraction" USING btree ("timestamp");--> statement-breakpoint
CREATE INDEX "NPCInteraction_actor1Id_idx" ON "NPCInteraction" USING btree ("actor1Id");--> statement-breakpoint
CREATE INDEX "NPCInteraction_actor2Id_idx" ON "NPCInteraction" USING btree ("actor2Id");--> statement-breakpoint
CREATE INDEX "NPCInteraction_interactionType_idx" ON "NPCInteraction" USING btree ("interactionType");--> statement-breakpoint
CREATE INDEX "NPCTrade_executedAt_idx" ON "NPCTrade" USING btree ("executedAt");--> statement-breakpoint
CREATE INDEX "NPCTrade_marketType_ticker_idx" ON "NPCTrade" USING btree ("marketType","ticker");--> statement-breakpoint
CREATE INDEX "NPCTrade_npcActorId_executedAt_idx" ON "NPCTrade" USING btree ("npcActorId","executedAt");--> statement-breakpoint
CREATE INDEX "NPCTrade_poolId_executedAt_idx" ON "NPCTrade" USING btree ("poolId","executedAt");--> statement-breakpoint
CREATE INDEX "AgentCapability_agentRegistryId_idx" ON "AgentCapability" USING btree ("agentRegistryId");--> statement-breakpoint
CREATE INDEX "AgentGoalAction_goalId_idx" ON "AgentGoalAction" USING btree ("goalId");--> statement-breakpoint
CREATE INDEX "AgentGoalAction_agentUserId_createdAt_idx" ON "AgentGoalAction" USING btree ("agentUserId","createdAt");--> statement-breakpoint
CREATE INDEX "AgentGoalAction_actionType_idx" ON "AgentGoalAction" USING btree ("actionType");--> statement-breakpoint
CREATE INDEX "AgentGoal_agentUserId_status_idx" ON "AgentGoal" USING btree ("agentUserId","status");--> statement-breakpoint
CREATE INDEX "AgentGoal_priority_idx" ON "AgentGoal" USING btree ("priority");--> statement-breakpoint
CREATE INDEX "AgentGoal_status_idx" ON "AgentGoal" USING btree ("status");--> statement-breakpoint
CREATE INDEX "AgentGoal_createdAt_idx" ON "AgentGoal" USING btree ("createdAt");--> statement-breakpoint
CREATE INDEX "AgentLog_agentUserId_createdAt_idx" ON "AgentLog" USING btree ("agentUserId","createdAt");--> statement-breakpoint
CREATE INDEX "AgentLog_level_idx" ON "AgentLog" USING btree ("level");--> statement-breakpoint
CREATE INDEX "AgentLog_type_createdAt_idx" ON "AgentLog" USING btree ("type","createdAt");--> statement-breakpoint
CREATE INDEX "AgentMessage_agentUserId_createdAt_idx" ON "AgentMessage" USING btree ("agentUserId","createdAt");--> statement-breakpoint
CREATE INDEX "AgentMessage_role_idx" ON "AgentMessage" USING btree ("role");--> statement-breakpoint
CREATE INDEX "AgentPerformanceMetrics_gamesPlayed_idx" ON "AgentPerformanceMetrics" USING btree ("gamesPlayed");--> statement-breakpoint
CREATE INDEX "AgentPerformanceMetrics_normalizedPnL_idx" ON "AgentPerformanceMetrics" USING btree ("normalizedPnL");--> statement-breakpoint
CREATE INDEX "AgentPerformanceMetrics_reputationScore_idx" ON "AgentPerformanceMetrics" USING btree ("reputationScore");--> statement-breakpoint
CREATE INDEX "AgentPerformanceMetrics_trustLevel_idx" ON "AgentPerformanceMetrics" USING btree ("trustLevel");--> statement-breakpoint
CREATE INDEX "AgentPerformanceMetrics_updatedAt_idx" ON "AgentPerformanceMetrics" USING btree ("updatedAt");--> statement-breakpoint
CREATE INDEX "AgentPointsTransaction_agentUserId_createdAt_idx" ON "AgentPointsTransaction" USING btree ("agentUserId","createdAt");--> statement-breakpoint
CREATE INDEX "AgentPointsTransaction_managerUserId_createdAt_idx" ON "AgentPointsTransaction" USING btree ("managerUserId","createdAt");--> statement-breakpoint
CREATE INDEX "AgentPointsTransaction_type_idx" ON "AgentPointsTransaction" USING btree ("type");--> statement-breakpoint
CREATE INDEX "AgentRegistry_type_status_idx" ON "AgentRegistry" USING btree ("type","status");--> statement-breakpoint
CREATE INDEX "AgentRegistry_trustLevel_idx" ON "AgentRegistry" USING btree ("trustLevel");--> statement-breakpoint
CREATE INDEX "AgentRegistry_userId_idx" ON "AgentRegistry" USING btree ("userId");--> statement-breakpoint
CREATE INDEX "AgentRegistry_actorId_idx" ON "AgentRegistry" USING btree ("actorId");--> statement-breakpoint
CREATE INDEX "AgentRegistry_status_lastActiveAt_idx" ON "AgentRegistry" USING btree ("status","lastActiveAt");--> statement-breakpoint
CREATE INDEX "AgentRegistry_type_trustLevel_idx" ON "AgentRegistry" USING btree ("type","trustLevel");--> statement-breakpoint
CREATE INDEX "AgentTrade_agentUserId_executedAt_idx" ON "AgentTrade" USING btree ("agentUserId","executedAt");--> statement-breakpoint
CREATE INDEX "AgentTrade_marketType_marketId_idx" ON "AgentTrade" USING btree ("marketType","marketId");--> statement-breakpoint
CREATE INDEX "AgentTrade_ticker_idx" ON "AgentTrade" USING btree ("ticker");--> statement-breakpoint
CREATE INDEX "ExternalAgentConnection_agentRegistryId_idx" ON "ExternalAgentConnection" USING btree ("agentRegistryId");--> statement-breakpoint
CREATE INDEX "ExternalAgentConnection_externalId_idx" ON "ExternalAgentConnection" USING btree ("externalId");--> statement-breakpoint
CREATE INDEX "ExternalAgentConnection_protocol_idx" ON "ExternalAgentConnection" USING btree ("protocol");--> statement-breakpoint
CREATE INDEX "ExternalAgentConnection_isHealthy_idx" ON "ExternalAgentConnection" USING btree ("isHealthy");--> statement-breakpoint
CREATE INDEX "Market_createdAt_idx" ON "Market" USING btree ("createdAt");--> statement-breakpoint
CREATE INDEX "Market_gameId_dayNumber_idx" ON "Market" USING btree ("gameId","dayNumber");--> statement-breakpoint
CREATE INDEX "Market_onChainMarketId_idx" ON "Market" USING btree ("onChainMarketId");--> statement-breakpoint
CREATE INDEX "Market_resolved_endDate_idx" ON "Market" USING btree ("resolved","endDate");--> statement-breakpoint
CREATE INDEX "Organization_currentPrice_idx" ON "Organization" USING btree ("currentPrice");--> statement-breakpoint
CREATE INDEX "Organization_type_idx" ON "Organization" USING btree ("type");--> statement-breakpoint
CREATE INDEX "Organization_ticker_idx" ON "Organization" USING btree ("ticker");--> statement-breakpoint
CREATE INDEX "PerpMarketSnapshot_orgId_idx" ON "PerpMarketSnapshot" USING btree ("organizationId");--> statement-breakpoint
CREATE INDEX "PerpPosition_organizationId_idx" ON "PerpPosition" USING btree ("organizationId");--> statement-breakpoint
CREATE INDEX "PerpPosition_settledToChain_idx" ON "PerpPosition" USING btree ("settledToChain");--> statement-breakpoint
CREATE INDEX "PerpPosition_ticker_idx" ON "PerpPosition" USING btree ("ticker");--> statement-breakpoint
CREATE INDEX "PerpPosition_userId_closedAt_idx" ON "PerpPosition" USING btree ("userId","closedAt");--> statement-breakpoint
CREATE INDEX "Position_marketId_idx" ON "Position" USING btree ("marketId");--> statement-breakpoint
CREATE INDEX "Position_questionId_idx" ON "Position" USING btree ("questionId");--> statement-breakpoint
CREATE INDEX "Position_status_idx" ON "Position" USING btree ("status");--> statement-breakpoint
CREATE INDEX "Position_userId_idx" ON "Position" USING btree ("userId");--> statement-breakpoint
CREATE INDEX "Position_userId_marketId_idx" ON "Position" USING btree ("userId","marketId");--> statement-breakpoint
CREATE INDEX "Position_userId_status_idx" ON "Position" USING btree ("userId","status");--> statement-breakpoint
CREATE INDEX "PredictionPriceHistory_marketId_createdAt_idx" ON "PredictionPriceHistory" USING btree ("marketId","createdAt");--> statement-breakpoint
CREATE INDEX "Question_createdDate_idx" ON "Question" USING btree ("createdDate");--> statement-breakpoint
CREATE INDEX "Question_oraclePublishedAt_idx" ON "Question" USING btree ("oraclePublishedAt");--> statement-breakpoint
CREATE INDEX "Question_oracleSessionId_idx" ON "Question" USING btree ("oracleSessionId");--> statement-breakpoint
CREATE INDEX "Question_status_resolutionDate_idx" ON "Question" USING btree ("status","resolutionDate");--> statement-breakpoint
CREATE INDEX "StockPrice_isSnapshot_timestamp_idx" ON "StockPrice" USING btree ("isSnapshot","timestamp");--> statement-breakpoint
CREATE INDEX "StockPrice_organizationId_timestamp_idx" ON "StockPrice" USING btree ("organizationId","timestamp");--> statement-breakpoint
CREATE INDEX "StockPrice_timestamp_idx" ON "StockPrice" USING btree ("timestamp");--> statement-breakpoint
CREATE INDEX "ChatAdmin_chatId_idx" ON "ChatAdmin" USING btree ("chatId");--> statement-breakpoint
CREATE INDEX "ChatAdmin_userId_idx" ON "ChatAdmin" USING btree ("userId");--> statement-breakpoint
CREATE INDEX "ChatInvite_chatId_idx" ON "ChatInvite" USING btree ("chatId");--> statement-breakpoint
CREATE INDEX "ChatInvite_invitedUserId_status_idx" ON "ChatInvite" USING btree ("invitedUserId","status");--> statement-breakpoint
CREATE INDEX "ChatInvite_status_idx" ON "ChatInvite" USING btree ("status");--> statement-breakpoint
CREATE INDEX "ChatParticipant_chatId_idx" ON "ChatParticipant" USING btree ("chatId");--> statement-breakpoint
CREATE INDEX "ChatParticipant_userId_idx" ON "ChatParticipant" USING btree ("userId");--> statement-breakpoint
CREATE INDEX "ChatParticipant_chatId_isActive_idx" ON "ChatParticipant" USING btree ("chatId","isActive");--> statement-breakpoint
CREATE INDEX "ChatParticipant_lastMessageAt_idx" ON "ChatParticipant" USING btree ("lastMessageAt");--> statement-breakpoint
CREATE INDEX "ChatParticipant_userId_isActive_idx" ON "ChatParticipant" USING btree ("userId","isActive");--> statement-breakpoint
CREATE INDEX "Chat_gameId_dayNumber_idx" ON "Chat" USING btree ("gameId","dayNumber");--> statement-breakpoint
CREATE INDEX "Chat_groupId_idx" ON "Chat" USING btree ("groupId");--> statement-breakpoint
CREATE INDEX "Chat_isGroup_idx" ON "Chat" USING btree ("isGroup");--> statement-breakpoint
CREATE INDEX "Chat_createdBy_idx" ON "Chat" USING btree ("createdBy");--> statement-breakpoint
CREATE INDEX "Chat_npcAdminId_idx" ON "Chat" USING btree ("npcAdminId");--> statement-breakpoint
CREATE INDEX "Chat_relatedQuestion_idx" ON "Chat" USING btree ("relatedQuestion");--> statement-breakpoint
CREATE INDEX "DMAcceptance_status_createdAt_idx" ON "DMAcceptance" USING btree ("status","createdAt");--> statement-breakpoint
CREATE INDEX "DMAcceptance_userId_status_idx" ON "DMAcceptance" USING btree ("userId","status");--> statement-breakpoint
CREATE INDEX "GroupChatMembership_chatId_isActive_idx" ON "GroupChatMembership" USING btree ("chatId","isActive");--> statement-breakpoint
CREATE INDEX "GroupChatMembership_lastMessageAt_idx" ON "GroupChatMembership" USING btree ("lastMessageAt");--> statement-breakpoint
CREATE INDEX "GroupChatMembership_userId_isActive_idx" ON "GroupChatMembership" USING btree ("userId","isActive");--> statement-breakpoint
CREATE INDEX "Message_chatId_createdAt_idx" ON "Message" USING btree ("chatId","createdAt");--> statement-breakpoint
CREATE INDEX "Message_senderId_idx" ON "Message" USING btree ("senderId");--> statement-breakpoint
CREATE INDEX "Notification_chatId_idx" ON "Notification" USING btree ("chatId");--> statement-breakpoint
CREATE INDEX "Notification_groupId_idx" ON "Notification" USING btree ("groupId");--> statement-breakpoint
CREATE INDEX "Notification_inviteId_idx" ON "Notification" USING btree ("inviteId");--> statement-breakpoint
CREATE INDEX "Notification_read_idx" ON "Notification" USING btree ("read");--> statement-breakpoint
CREATE INDEX "Notification_userId_createdAt_idx" ON "Notification" USING btree ("userId","createdAt");--> statement-breakpoint
CREATE INDEX "Notification_userId_read_createdAt_idx" ON "Notification" USING btree ("userId","read","createdAt");--> statement-breakpoint
CREATE INDEX "Notification_userId_type_read_idx" ON "Notification" USING btree ("userId","type","read");--> statement-breakpoint
CREATE INDEX "UserGroupAdmin_groupId_idx" ON "UserGroupAdmin" USING btree ("groupId");--> statement-breakpoint
CREATE INDEX "UserGroupAdmin_userId_idx" ON "UserGroupAdmin" USING btree ("userId");--> statement-breakpoint
CREATE INDEX "UserGroupInvite_groupId_idx" ON "UserGroupInvite" USING btree ("groupId");--> statement-breakpoint
CREATE INDEX "UserGroupInvite_invitedUserId_status_idx" ON "UserGroupInvite" USING btree ("invitedUserId","status");--> statement-breakpoint
CREATE INDEX "UserGroupInvite_status_idx" ON "UserGroupInvite" USING btree ("status");--> statement-breakpoint
CREATE INDEX "UserGroupMember_groupId_idx" ON "UserGroupMember" USING btree ("groupId");--> statement-breakpoint
CREATE INDEX "UserGroupMember_userId_idx" ON "UserGroupMember" USING btree ("userId");--> statement-breakpoint
CREATE INDEX "UserGroup_createdAt_idx" ON "UserGroup" USING btree ("createdAt");--> statement-breakpoint
CREATE INDEX "UserGroup_createdById_idx" ON "UserGroup" USING btree ("createdById");--> statement-breakpoint
CREATE INDEX "GameConfig_key_idx" ON "GameConfig" USING btree ("key");--> statement-breakpoint
CREATE INDEX "Game_isContinuous_idx" ON "Game" USING btree ("isContinuous");--> statement-breakpoint
CREATE INDEX "Game_isRunning_idx" ON "Game" USING btree ("isRunning");--> statement-breakpoint
CREATE INDEX "GenerationLock_expiresAt_idx" ON "GenerationLock" USING btree ("expiresAt");--> statement-breakpoint
CREATE INDEX "OAuthState_expiresAt_idx" ON "OAuthState" USING btree ("expiresAt");--> statement-breakpoint
CREATE INDEX "OAuthState_state_idx" ON "OAuthState" USING btree ("state");--> statement-breakpoint
CREATE INDEX "OracleCommitment_createdAt_idx" ON "OracleCommitment" USING btree ("createdAt");--> statement-breakpoint
CREATE INDEX "OracleCommitment_questionId_idx" ON "OracleCommitment" USING btree ("questionId");--> statement-breakpoint
CREATE INDEX "OracleCommitment_sessionId_idx" ON "OracleCommitment" USING btree ("sessionId");--> statement-breakpoint
CREATE INDEX "OracleTransaction_questionId_idx" ON "OracleTransaction" USING btree ("questionId");--> statement-breakpoint
CREATE INDEX "OracleTransaction_status_createdAt_idx" ON "OracleTransaction" USING btree ("status","createdAt");--> statement-breakpoint
CREATE INDEX "OracleTransaction_txHash_idx" ON "OracleTransaction" USING btree ("txHash");--> statement-breakpoint
CREATE INDEX "OracleTransaction_txType_idx" ON "OracleTransaction" USING btree ("txType");--> statement-breakpoint
CREATE INDEX "ParodyHeadline_isUsed_generatedAt_idx" ON "ParodyHeadline" USING btree ("isUsed","generatedAt");--> statement-breakpoint
CREATE INDEX "ParodyHeadline_generatedAt_idx" ON "ParodyHeadline" USING btree ("generatedAt");--> statement-breakpoint
CREATE INDEX "RealtimeOutbox_status_createdAt_idx" ON "RealtimeOutbox" USING btree ("status","createdAt");--> statement-breakpoint
CREATE INDEX "RealtimeOutbox_channel_status_idx" ON "RealtimeOutbox" USING btree ("channel","status");--> statement-breakpoint
CREATE INDEX "RSSFeedSource_isActive_lastFetched_idx" ON "RSSFeedSource" USING btree ("isActive","lastFetched");--> statement-breakpoint
CREATE INDEX "RSSFeedSource_category_idx" ON "RSSFeedSource" USING btree ("category");--> statement-breakpoint
CREATE INDEX "RSSHeadline_sourceId_publishedAt_idx" ON "RSSHeadline" USING btree ("sourceId","publishedAt");--> statement-breakpoint
CREATE INDEX "RSSHeadline_publishedAt_idx" ON "RSSHeadline" USING btree ("publishedAt");--> statement-breakpoint
CREATE INDEX "TickTokenStats_tickStartedAt_idx" ON "TickTokenStats" USING btree ("tickStartedAt");--> statement-breakpoint
CREATE INDEX "TickTokenStats_tickId_idx" ON "TickTokenStats" USING btree ("tickId");--> statement-breakpoint
CREATE INDEX "TickTokenStats_createdAt_idx" ON "TickTokenStats" USING btree ("createdAt");--> statement-breakpoint
CREATE INDEX "WidgetCache_widget_updatedAt_idx" ON "WidgetCache" USING btree ("widget","updatedAt");--> statement-breakpoint
CREATE INDEX "WorldEvent_gameId_dayNumber_idx" ON "WorldEvent" USING btree ("gameId","dayNumber");--> statement-breakpoint
CREATE INDEX "WorldEvent_relatedQuestion_idx" ON "WorldEvent" USING btree ("relatedQuestion");--> statement-breakpoint
CREATE INDEX "WorldEvent_timestamp_idx" ON "WorldEvent" USING btree ("timestamp");--> statement-breakpoint
CREATE INDEX "WorldFact_category_isActive_idx" ON "WorldFact" USING btree ("category","isActive");--> statement-breakpoint
CREATE INDEX "WorldFact_priority_idx" ON "WorldFact" USING btree ("priority");--> statement-breakpoint
CREATE INDEX "WorldFact_lastUpdated_idx" ON "WorldFact" USING btree ("lastUpdated");--> statement-breakpoint
CREATE INDEX "QuestionArcPlan_questionId_idx" ON "QuestionArcPlan" USING btree ("questionId");--> statement-breakpoint
CREATE INDEX "OrganizationState_currentPrice_idx" ON "OrganizationState" USING btree ("currentPrice");--> statement-breakpoint
CREATE INDEX "PoolDeposit_poolId_userId_idx" ON "PoolDeposit" USING btree ("poolId","userId");--> statement-breakpoint
CREATE INDEX "PoolDeposit_poolId_withdrawnAt_idx" ON "PoolDeposit" USING btree ("poolId","withdrawnAt");--> statement-breakpoint
CREATE INDEX "PoolDeposit_userId_depositedAt_idx" ON "PoolDeposit" USING btree ("userId","depositedAt");--> statement-breakpoint
CREATE INDEX "PoolPosition_marketType_marketId_idx" ON "PoolPosition" USING btree ("marketType","marketId");--> statement-breakpoint
CREATE INDEX "PoolPosition_marketType_ticker_idx" ON "PoolPosition" USING btree ("marketType","ticker");--> statement-breakpoint
CREATE INDEX "PoolPosition_poolId_closedAt_idx" ON "PoolPosition" USING btree ("poolId","closedAt");--> statement-breakpoint
CREATE INDEX "Pool_isActive_idx" ON "Pool" USING btree ("isActive");--> statement-breakpoint
CREATE INDEX "Pool_npcActorId_idx" ON "Pool" USING btree ("npcActorId");--> statement-breakpoint
CREATE INDEX "Pool_status_idx" ON "Pool" USING btree ("status");--> statement-breakpoint
CREATE INDEX "Pool_totalValue_idx" ON "Pool" USING btree ("totalValue");--> statement-breakpoint
CREATE INDEX "Pool_volume24h_idx" ON "Pool" USING btree ("volume24h");--> statement-breakpoint
CREATE INDEX "Comment_authorId_idx" ON "Comment" USING btree ("authorId");--> statement-breakpoint
CREATE INDEX "Comment_deletedAt_idx" ON "Comment" USING btree ("deletedAt");--> statement-breakpoint
CREATE INDEX "Comment_parentCommentId_idx" ON "Comment" USING btree ("parentCommentId");--> statement-breakpoint
CREATE INDEX "Comment_postId_createdAt_idx" ON "Comment" USING btree ("postId","createdAt");--> statement-breakpoint
CREATE INDEX "Comment_postId_deletedAt_idx" ON "Comment" USING btree ("postId","deletedAt");--> statement-breakpoint
CREATE INDEX "PostTag_postId_idx" ON "PostTag" USING btree ("postId");--> statement-breakpoint
CREATE INDEX "PostTag_tagId_createdAt_idx" ON "PostTag" USING btree ("tagId","createdAt");--> statement-breakpoint
CREATE INDEX "PostTag_tagId_idx" ON "PostTag" USING btree ("tagId");--> statement-breakpoint
CREATE INDEX "Post_authorId_timestamp_idx" ON "Post" USING btree ("authorId","timestamp");--> statement-breakpoint
CREATE INDEX "Post_authorId_type_timestamp_idx" ON "Post" USING btree ("authorId","type","timestamp");--> statement-breakpoint
CREATE INDEX "Post_commentOnPostId_idx" ON "Post" USING btree ("commentOnPostId");--> statement-breakpoint
CREATE INDEX "Post_deletedAt_idx" ON "Post" USING btree ("deletedAt");--> statement-breakpoint
CREATE INDEX "Post_gameId_dayNumber_idx" ON "Post" USING btree ("gameId","dayNumber");--> statement-breakpoint
CREATE INDEX "Post_parentCommentId_idx" ON "Post" USING btree ("parentCommentId");--> statement-breakpoint
CREATE INDEX "Post_originalPostId_idx" ON "Post" USING btree ("originalPostId");--> statement-breakpoint
CREATE INDEX "Post_timestamp_idx" ON "Post" USING btree ("timestamp");--> statement-breakpoint
CREATE INDEX "Post_type_deletedAt_timestamp_idx" ON "Post" USING btree ("type","deletedAt","timestamp");--> statement-breakpoint
CREATE INDEX "Post_type_timestamp_idx" ON "Post" USING btree ("type","timestamp");--> statement-breakpoint
CREATE INDEX "Reaction_commentId_idx" ON "Reaction" USING btree ("commentId");--> statement-breakpoint
CREATE INDEX "Reaction_postId_idx" ON "Reaction" USING btree ("postId");--> statement-breakpoint
CREATE INDEX "Reaction_userId_idx" ON "Reaction" USING btree ("userId");--> statement-breakpoint
CREATE INDEX "ShareAction_contentType_idx" ON "ShareAction" USING btree ("contentType");--> statement-breakpoint
CREATE INDEX "ShareAction_platform_idx" ON "ShareAction" USING btree ("platform");--> statement-breakpoint
CREATE INDEX "ShareAction_userId_createdAt_idx" ON "ShareAction" USING btree ("userId","createdAt");--> statement-breakpoint
CREATE INDEX "ShareAction_verified_idx" ON "ShareAction" USING btree ("verified");--> statement-breakpoint
CREATE INDEX "Share_createdAt_idx" ON "Share" USING btree ("createdAt");--> statement-breakpoint
CREATE INDEX "Share_postId_idx" ON "Share" USING btree ("postId");--> statement-breakpoint
CREATE INDEX "Share_userId_idx" ON "Share" USING btree ("userId");--> statement-breakpoint
CREATE INDEX "Tag_name_idx" ON "Tag" USING btree ("name");--> statement-breakpoint
CREATE INDEX "TrendingTag_calculatedAt_idx" ON "TrendingTag" USING btree ("calculatedAt");--> statement-breakpoint
CREATE INDEX "TrendingTag_rank_calculatedAt_idx" ON "TrendingTag" USING btree ("rank","calculatedAt");--> statement-breakpoint
CREATE INDEX "TrendingTag_tagId_calculatedAt_idx" ON "TrendingTag" USING btree ("tagId","calculatedAt");--> statement-breakpoint
CREATE INDEX "BalanceTransaction_type_idx" ON "BalanceTransaction" USING btree ("type");--> statement-breakpoint
CREATE INDEX "BalanceTransaction_userId_createdAt_idx" ON "BalanceTransaction" USING btree ("userId","createdAt");--> statement-breakpoint
CREATE INDEX "Feedback_createdAt_idx" ON "Feedback" USING btree ("createdAt");--> statement-breakpoint
CREATE INDEX "Feedback_fromUserId_idx" ON "Feedback" USING btree ("fromUserId");--> statement-breakpoint
CREATE INDEX "Feedback_gameId_idx" ON "Feedback" USING btree ("gameId");--> statement-breakpoint
CREATE INDEX "Feedback_interactionType_idx" ON "Feedback" USING btree ("interactionType");--> statement-breakpoint
CREATE INDEX "Feedback_score_idx" ON "Feedback" USING btree ("score");--> statement-breakpoint
CREATE INDEX "Feedback_toAgentId_idx" ON "Feedback" USING btree ("toAgentId");--> statement-breakpoint
CREATE INDEX "Feedback_toUserId_idx" ON "Feedback" USING btree ("toUserId");--> statement-breakpoint
CREATE INDEX "Feedback_toUserId_interactionType_idx" ON "Feedback" USING btree ("toUserId","interactionType");--> statement-breakpoint
CREATE INDEX "ModerationEscrow_recipientId_createdAt_idx" ON "ModerationEscrow" USING btree ("recipientId","createdAt");--> statement-breakpoint
CREATE INDEX "ModerationEscrow_adminId_idx" ON "ModerationEscrow" USING btree ("adminId");--> statement-breakpoint
CREATE INDEX "ModerationEscrow_status_idx" ON "ModerationEscrow" USING btree ("status");--> statement-breakpoint
CREATE INDEX "ModerationEscrow_paymentRequestId_idx" ON "ModerationEscrow" USING btree ("paymentRequestId");--> statement-breakpoint
CREATE INDEX "ModerationEscrow_paymentTxHash_idx" ON "ModerationEscrow" USING btree ("paymentTxHash");--> statement-breakpoint
CREATE INDEX "ModerationEscrow_createdAt_idx" ON "ModerationEscrow" USING btree ("createdAt");--> statement-breakpoint
CREATE INDEX "PointsTransaction_createdAt_idx" ON "PointsTransaction" USING btree ("createdAt");--> statement-breakpoint
CREATE INDEX "PointsTransaction_paymentRequestId_idx" ON "PointsTransaction" USING btree ("paymentRequestId");--> statement-breakpoint
CREATE INDEX "PointsTransaction_reason_idx" ON "PointsTransaction" USING btree ("reason");--> statement-breakpoint
CREATE INDEX "PointsTransaction_userId_createdAt_idx" ON "PointsTransaction" USING btree ("userId","createdAt");--> statement-breakpoint
CREATE INDEX "Report_reporterId_idx" ON "Report" USING btree ("reporterId");--> statement-breakpoint
CREATE INDEX "Report_reportedUserId_idx" ON "Report" USING btree ("reportedUserId");--> statement-breakpoint
CREATE INDEX "Report_reportedPostId_idx" ON "Report" USING btree ("reportedPostId");--> statement-breakpoint
CREATE INDEX "Report_status_idx" ON "Report" USING btree ("status");--> statement-breakpoint
CREATE INDEX "Report_priority_status_idx" ON "Report" USING btree ("priority","status");--> statement-breakpoint
CREATE INDEX "Report_category_idx" ON "Report" USING btree ("category");--> statement-breakpoint
CREATE INDEX "Report_createdAt_idx" ON "Report" USING btree ("createdAt");--> statement-breakpoint
CREATE INDEX "Report_reportedUserId_status_idx" ON "Report" USING btree ("reportedUserId","status");--> statement-breakpoint
CREATE INDEX "Report_reportedPostId_status_idx" ON "Report" USING btree ("reportedPostId","status");--> statement-breakpoint
CREATE INDEX "TradingFee_createdAt_idx" ON "TradingFee" USING btree ("createdAt");--> statement-breakpoint
CREATE INDEX "TradingFee_referrerId_createdAt_idx" ON "TradingFee" USING btree ("referrerId","createdAt");--> statement-breakpoint
CREATE INDEX "TradingFee_tradeType_idx" ON "TradingFee" USING btree ("tradeType");--> statement-breakpoint
CREATE INDEX "TradingFee_userId_createdAt_idx" ON "TradingFee" USING btree ("userId","createdAt");--> statement-breakpoint
CREATE INDEX "benchmark_results_modelId_idx" ON "benchmark_results" USING btree ("modelId");--> statement-breakpoint
CREATE INDEX "benchmark_results_benchmarkId_idx" ON "benchmark_results" USING btree ("benchmarkId");--> statement-breakpoint
CREATE INDEX "benchmark_results_runAt_idx" ON "benchmark_results" USING btree ("runAt");--> statement-breakpoint
CREATE INDEX "benchmark_results_optimalityScore_idx" ON "benchmark_results" USING btree ("optimalityScore");--> statement-breakpoint
CREATE INDEX "llm_call_logs_callId_idx" ON "llm_call_logs" USING btree ("callId");--> statement-breakpoint
CREATE INDEX "llm_call_logs_timestamp_idx" ON "llm_call_logs" USING btree ("timestamp");--> statement-breakpoint
CREATE INDEX "llm_call_logs_trajectoryId_idx" ON "llm_call_logs" USING btree ("trajectoryId");--> statement-breakpoint
CREATE INDEX "market_outcomes_windowId_idx" ON "market_outcomes" USING btree ("windowId");--> statement-breakpoint
CREATE INDEX "market_outcomes_windowId_stockTicker_idx" ON "market_outcomes" USING btree ("windowId","stockTicker");--> statement-breakpoint
CREATE INDEX "reward_judgments_overallScore_idx" ON "reward_judgments" USING btree ("overallScore");--> statement-breakpoint
CREATE INDEX "reward_judgments_groupId_rank_idx" ON "reward_judgments" USING btree ("groupId","rank");--> statement-breakpoint
CREATE INDEX "trained_models_status_idx" ON "trained_models" USING btree ("status");--> statement-breakpoint
CREATE INDEX "trained_models_version_idx" ON "trained_models" USING btree ("version");--> statement-breakpoint
CREATE INDEX "trained_models_deployedAt_idx" ON "trained_models" USING btree ("deployedAt");--> statement-breakpoint
CREATE INDEX "trained_models_lastBenchmarked_idx" ON "trained_models" USING btree ("lastBenchmarked");--> statement-breakpoint
CREATE INDEX "training_batches_scenarioId_idx" ON "training_batches" USING btree ("scenarioId");--> statement-breakpoint
CREATE INDEX "training_batches_status_createdAt_idx" ON "training_batches" USING btree ("status","createdAt");--> statement-breakpoint
CREATE INDEX "trajectories_agentId_startTime_idx" ON "trajectories" USING btree ("agentId","startTime");--> statement-breakpoint
CREATE INDEX "trajectories_aiJudgeReward_idx" ON "trajectories" USING btree ("aiJudgeReward");--> statement-breakpoint
CREATE INDEX "trajectories_isTrainingData_usedInTraining_idx" ON "trajectories" USING btree ("isTrainingData","usedInTraining");--> statement-breakpoint
CREATE INDEX "trajectories_scenarioId_createdAt_idx" ON "trajectories" USING btree ("scenarioId","createdAt");--> statement-breakpoint
CREATE INDEX "trajectories_trainedInBatch_idx" ON "trajectories" USING btree ("trainedInBatch");--> statement-breakpoint
CREATE INDEX "trajectories_windowId_agentId_idx" ON "trajectories" USING btree ("windowId","agentId");--> statement-breakpoint
CREATE INDEX "trajectories_windowId_idx" ON "trajectories" USING btree ("windowId");--> statement-breakpoint
CREATE INDEX "trajectories_archetype_idx" ON "trajectories" USING btree ("archetype");--> statement-breakpoint
CREATE INDEX "UserAgentConfig_userId_idx" ON "UserAgentConfig" USING btree ("userId");--> statement-breakpoint
CREATE INDEX "UserAgentConfig_status_idx" ON "UserAgentConfig" USING btree ("status");--> statement-breakpoint
CREATE INDEX "UserAgentConfig_autonomousTrading_idx" ON "UserAgentConfig" USING btree ("autonomousTrading");--> statement-breakpoint
CREATE INDEX "Favorite_targetUserId_idx" ON "Favorite" USING btree ("targetUserId");--> statement-breakpoint
CREATE INDEX "Favorite_userId_idx" ON "Favorite" USING btree ("userId");--> statement-breakpoint
CREATE INDEX "FollowStatus_npcId_idx" ON "FollowStatus" USING btree ("npcId");--> statement-breakpoint
CREATE INDEX "FollowStatus_userId_isActive_idx" ON "FollowStatus" USING btree ("userId","isActive");--> statement-breakpoint
CREATE INDEX "Follow_followerId_idx" ON "Follow" USING btree ("followerId");--> statement-breakpoint
CREATE INDEX "Follow_followingId_idx" ON "Follow" USING btree ("followingId");--> statement-breakpoint
CREATE INDEX "OnboardingIntent_createdAt_idx" ON "OnboardingIntent" USING btree ("createdAt");--> statement-breakpoint
CREATE INDEX "OnboardingIntent_status_idx" ON "OnboardingIntent" USING btree ("status");--> statement-breakpoint
CREATE INDEX "ProfileUpdateLog_userId_createdAt_idx" ON "ProfileUpdateLog" USING btree ("userId","createdAt");--> statement-breakpoint
CREATE INDEX "Referral_referralCode_idx" ON "Referral" USING btree ("referralCode");--> statement-breakpoint
CREATE INDEX "Referral_referrerId_idx" ON "Referral" USING btree ("referrerId");--> statement-breakpoint
CREATE INDEX "Referral_referredUserId_idx" ON "Referral" USING btree ("referredUserId");--> statement-breakpoint
CREATE INDEX "Referral_status_createdAt_idx" ON "Referral" USING btree ("status","createdAt");--> statement-breakpoint
CREATE INDEX "Referral_qualifiedAt_idx" ON "Referral" USING btree ("qualifiedAt");--> statement-breakpoint
CREATE INDEX "Referral_referrerId_status_qualifiedAt_signupPointsAwarded_idx" ON "Referral" USING btree ("referrerId","status","qualifiedAt","signupPointsAwarded");--> statement-breakpoint
CREATE INDEX "Referral_referrerId_signupPointsAwarded_completedAt_idx" ON "Referral" USING btree ("referrerId","signupPointsAwarded","completedAt");--> statement-breakpoint
CREATE INDEX "TwitterOAuthToken_userId_idx" ON "TwitterOAuthToken" USING btree ("userId");--> statement-breakpoint
CREATE INDEX "UserActorFollow_actorId_idx" ON "UserActorFollow" USING btree ("actorId");--> statement-breakpoint
CREATE INDEX "UserActorFollow_userId_idx" ON "UserActorFollow" USING btree ("userId");--> statement-breakpoint
CREATE INDEX "UserApiKey_userId_idx" ON "UserApiKey" USING btree ("userId");--> statement-breakpoint
CREATE INDEX "UserApiKey_keyHash_idx" ON "UserApiKey" USING btree ("keyHash");--> statement-breakpoint
CREATE INDEX "UserApiKey_userId_revokedAt_idx" ON "UserApiKey" USING btree ("userId","revokedAt");--> statement-breakpoint
CREATE INDEX "UserBlock_blockerId_idx" ON "UserBlock" USING btree ("blockerId");--> statement-breakpoint
CREATE INDEX "UserBlock_blockedId_idx" ON "UserBlock" USING btree ("blockedId");--> statement-breakpoint
CREATE INDEX "UserBlock_createdAt_idx" ON "UserBlock" USING btree ("createdAt");--> statement-breakpoint
CREATE INDEX "UserInteraction_npcId_timestamp_idx" ON "UserInteraction" USING btree ("npcId","timestamp");--> statement-breakpoint
CREATE INDEX "UserInteraction_userId_npcId_timestamp_idx" ON "UserInteraction" USING btree ("userId","npcId","timestamp");--> statement-breakpoint
CREATE INDEX "UserInteraction_userId_timestamp_idx" ON "UserInteraction" USING btree ("userId","timestamp");--> statement-breakpoint
CREATE INDEX "UserMute_muterId_idx" ON "UserMute" USING btree ("muterId");--> statement-breakpoint
CREATE INDEX "UserMute_mutedId_idx" ON "UserMute" USING btree ("mutedId");--> statement-breakpoint
CREATE INDEX "UserMute_createdAt_idx" ON "UserMute" USING btree ("createdAt");--> statement-breakpoint
CREATE INDEX "User_displayName_idx" ON "User" USING btree ("displayName");--> statement-breakpoint
CREATE INDEX "User_earnedPoints_idx" ON "User" USING btree ("earnedPoints");--> statement-breakpoint
CREATE INDEX "User_invitePoints_idx" ON "User" USING btree ("invitePoints");--> statement-breakpoint
CREATE INDEX "User_isActor_idx" ON "User" USING btree ("isActor");--> statement-breakpoint
CREATE INDEX "User_isAgent_idx" ON "User" USING btree ("isAgent");--> statement-breakpoint
CREATE INDEX "User_isAgent_managedBy_idx" ON "User" USING btree ("isAgent","managedBy");--> statement-breakpoint
CREATE INDEX "User_isBanned_isActor_idx" ON "User" USING btree ("isBanned","isActor");--> statement-breakpoint
CREATE INDEX "User_isScammer_idx" ON "User" USING btree ("isScammer");--> statement-breakpoint
CREATE INDEX "User_isCSAM_idx" ON "User" USING btree ("isCSAM");--> statement-breakpoint
CREATE INDEX "User_managedBy_idx" ON "User" USING btree ("managedBy");--> statement-breakpoint
CREATE INDEX "User_profileComplete_createdAt_idx" ON "User" USING btree ("profileComplete","createdAt");--> statement-breakpoint
CREATE INDEX "User_referralCode_idx" ON "User" USING btree ("referralCode");--> statement-breakpoint
CREATE INDEX "User_reputationPoints_idx" ON "User" USING btree ("reputationPoints");--> statement-breakpoint
CREATE INDEX "User_username_idx" ON "User" USING btree ("username");--> statement-breakpoint
CREATE INDEX "User_waitlistJoinedAt_idx" ON "User" USING btree ("waitlistJoinedAt");--> statement-breakpoint
CREATE INDEX "User_waitlistPosition_idx" ON "User" USING btree ("waitlistPosition");--> statement-breakpoint
CREATE INDEX "User_walletAddress_idx" ON "User" USING btree ("walletAddress");--> statement-breakpoint
CREATE INDEX "User_registrationIpHash_idx" ON "User" USING btree ("registrationIpHash");--> statement-breakpoint
CREATE INDEX "User_lastReferralIpHash_idx" ON "User" USING btree ("lastReferralIpHash");