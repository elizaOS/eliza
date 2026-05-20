-- Add missing Session + NFT tables used by waitlist/eligibility endpoints.
-- This is intentionally idempotent (IF NOT EXISTS) to allow safe re-runs.

-- ============================================================================
-- Sessions
-- ============================================================================

CREATE TABLE IF NOT EXISTS "UserSession" (
  "id" text PRIMARY KEY NOT NULL,
  "userId" text NOT NULL,
  "sessionId" text NOT NULL,
  "startedAt" timestamp NOT NULL,
  "lastActiveAt" timestamp NOT NULL,
  "endedAt" timestamp,
  "deviceType" text,
  "userAgent" text,
  "ipHash" text,
  "pageCount" integer DEFAULT 0 NOT NULL,
  "heartbeatCount" integer DEFAULT 1 NOT NULL,
  "createdAt" timestamp DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "UserSession_userId_startedAt_idx" ON "UserSession" ("userId","startedAt");
CREATE INDEX IF NOT EXISTS "UserSession_userId_endedAt_idx" ON "UserSession" ("userId","endedAt");
CREATE INDEX IF NOT EXISTS "UserSession_startedAt_idx" ON "UserSession" ("startedAt");
CREATE INDEX IF NOT EXISTS "UserSession_lastActiveAt_idx" ON "UserSession" ("lastActiveAt");
CREATE INDEX IF NOT EXISTS "UserSession_sessionId_idx" ON "UserSession" ("sessionId");

CREATE TABLE IF NOT EXISTS "UserActivityLog" (
  "id" text PRIMARY KEY NOT NULL,
  "userId" text NOT NULL,
  "activityType" text NOT NULL,
  "activityDate" timestamp NOT NULL,
  "createdAt" timestamp DEFAULT now() NOT NULL
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'UserActivityLog_userId_activityDate_activityType_idx'
  ) THEN
    ALTER TABLE "UserActivityLog"
      ADD CONSTRAINT "UserActivityLog_userId_activityDate_activityType_idx"
      UNIQUE ("userId","activityDate","activityType");
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "UserActivityLog_activityDate_idx" ON "UserActivityLog" ("activityDate");
CREATE INDEX IF NOT EXISTS "UserActivityLog_userId_activityDate_idx" ON "UserActivityLog" ("userId","activityDate");

-- ============================================================================
-- NFT tables
-- ============================================================================

CREATE TABLE IF NOT EXISTS "NftCollection" (
  "id" text PRIMARY KEY NOT NULL,
  "tokenId" integer NOT NULL,
  "name" text NOT NULL,
  "description" text,
  "imageUrl" text NOT NULL,
  "thumbnailUrl" text,
  "imageCid" text,
  "storyTitle" text,
  "storyContent" text,
  "metadataUri" text,
  "attributes" json,
  "contractAddress" text NOT NULL,
  "chainId" integer DEFAULT 1 NOT NULL,
  "createdAt" timestamp DEFAULT now() NOT NULL,
  "updatedAt" timestamp NOT NULL
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'NftCollection_tokenId_unique'
  ) THEN
    ALTER TABLE "NftCollection"
      ADD CONSTRAINT "NftCollection_tokenId_unique"
      UNIQUE ("tokenId");
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "NftCollection_tokenId_idx" ON "NftCollection" ("tokenId");
CREATE INDEX IF NOT EXISTS "NftCollection_contractAddress_idx" ON "NftCollection" ("contractAddress");

CREATE TABLE IF NOT EXISTS "NftOwnership" (
  "id" text PRIMARY KEY NOT NULL,
  "tokenId" integer NOT NULL,
  "ownerAddress" text NOT NULL,
  "userId" text,
  "acquiredAt" timestamp NOT NULL,
  "txHash" text,
  "blockNumber" bigint,
  "updatedAt" timestamp NOT NULL
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'NftOwnership_tokenId_key'
  ) THEN
    ALTER TABLE "NftOwnership"
      ADD CONSTRAINT "NftOwnership_tokenId_key"
      UNIQUE ("tokenId");
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "NftOwnership_ownerAddress_idx" ON "NftOwnership" ("ownerAddress");
CREATE INDEX IF NOT EXISTS "NftOwnership_userId_idx" ON "NftOwnership" ("userId");
CREATE INDEX IF NOT EXISTS "NftOwnership_updatedAt_idx" ON "NftOwnership" ("updatedAt");

CREATE TABLE IF NOT EXISTS "NftClaim" (
  "id" text PRIMARY KEY NOT NULL,
  "tokenId" integer NOT NULL,
  "claimerUserId" text,
  "claimerAddress" text NOT NULL,
  "claimedAt" timestamp NOT NULL,
  "txHash" text NOT NULL,
  "snapshotRank" integer,
  "snapshotPoints" integer
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'NftClaim_tokenId_key'
  ) THEN
    ALTER TABLE "NftClaim"
      ADD CONSTRAINT "NftClaim_tokenId_key"
      UNIQUE ("tokenId");
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "NftClaim_claimerUserId_idx" ON "NftClaim" ("claimerUserId");
CREATE INDEX IF NOT EXISTS "NftClaim_claimerAddress_idx" ON "NftClaim" ("claimerAddress");

CREATE TABLE IF NOT EXISTS "NftSnapshot" (
  "id" text PRIMARY KEY NOT NULL,
  "userId" text NOT NULL,
  "walletAddress" text,
  "rank" integer NOT NULL,
  "points" integer NOT NULL,
  "snapshotTakenAt" timestamp NOT NULL,
  "hasMinted" boolean DEFAULT false NOT NULL,
  "mintedTokenId" integer,
  "mintedAt" timestamp,
  "mintTxHash" text
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'NftSnapshot_userId_key'
  ) THEN
    ALTER TABLE "NftSnapshot"
      ADD CONSTRAINT "NftSnapshot_userId_key"
      UNIQUE ("userId");
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "NftSnapshot_walletAddress_idx" ON "NftSnapshot" ("walletAddress");
CREATE INDEX IF NOT EXISTS "NftSnapshot_hasMinted_idx" ON "NftSnapshot" ("hasMinted");
CREATE INDEX IF NOT EXISTS "NftSnapshot_rank_idx" ON "NftSnapshot" ("rank");

