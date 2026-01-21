import { relations } from "drizzle-orm";
import {
  bigint,
  boolean,
  index,
  integer,
  json,
  pgTable,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";
import { users } from "./users";

/**
 * NFT Collection - Stores metadata for each NFT in the collection
 *
 * This table caches NFT metadata from IPFS for faster queries.
 * Each record represents one NFT in the Polyagent Top 100 collection.
 */
export const nftCollection = pgTable(
  "NftCollection",
  {
    id: text("id").primaryKey(),
    tokenId: integer("tokenId").unique().notNull(),
    name: text("name").notNull(),
    description: text("description"),
    imageUrl: text("imageUrl").notNull(),
    thumbnailUrl: text("thumbnailUrl"),
    imageCid: text("imageCid"),
    storyTitle: text("storyTitle"),
    storyContent: text("storyContent"),
    metadataUri: text("metadataUri"),
    attributes:
      json("attributes").$type<
        Array<{ trait_type: string; value: string | number }>
      >(),
    contractAddress: text("contractAddress").notNull(),
    chainId: integer("chainId").notNull().default(1),
    createdAt: timestamp("createdAt", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updatedAt", { mode: "date" }).notNull(),
  },
  (table) => [
    index("NftCollection_tokenId_idx").on(table.tokenId),
    index("NftCollection_contractAddress_idx").on(table.contractAddress),
  ],
);

/**
 * NFT Ownership - Tracks current ownership of each NFT (real-time)
 *
 * This table is updated via blockchain webhooks/indexer to reflect
 * the current on-chain ownership state.
 */
export const nftOwnership = pgTable(
  "NftOwnership",
  {
    id: text("id").primaryKey(),
    tokenId: integer("tokenId").notNull(),
    ownerAddress: text("ownerAddress").notNull(),
    userId: text("userId"),
    acquiredAt: timestamp("acquiredAt", { mode: "date" }).notNull(),
    txHash: text("txHash"),
    blockNumber: bigint("blockNumber", { mode: "bigint" }),
    updatedAt: timestamp("updatedAt", { mode: "date" }).notNull(),
  },
  (table) => [
    unique("NftOwnership_tokenId_key").on(table.tokenId),
    index("NftOwnership_ownerAddress_idx").on(table.ownerAddress),
    index("NftOwnership_userId_idx").on(table.userId),
    index("NftOwnership_updatedAt_idx").on(table.updatedAt),
  ],
);

/**
 * NFT Claims - Records original claims from Top 100 leaderboard users
 *
 * This table tracks who originally minted each NFT from the claim process.
 * Even if the NFT is later transferred, this record remains as provenance.
 */
export const nftClaims = pgTable(
  "NftClaim",
  {
    id: text("id").primaryKey(),
    tokenId: integer("tokenId").notNull(),
    claimerUserId: text("claimerUserId"),
    claimerAddress: text("claimerAddress").notNull(),
    claimedAt: timestamp("claimedAt", { mode: "date" }).notNull(),
    txHash: text("txHash").notNull(),
    snapshotRank: integer("snapshotRank"),
    snapshotPoints: integer("snapshotPoints"),
  },
  (table) => [
    unique("NftClaim_tokenId_key").on(table.tokenId),
    index("NftClaim_claimerUserId_idx").on(table.claimerUserId),
    index("NftClaim_claimerAddress_idx").on(table.claimerAddress),
  ],
);

/**
 * NFT Snapshot - Records the Top 100 leaderboard snapshot for eligibility
 *
 * This table stores which users are eligible to mint, based on the
 * midnight UTC snapshot of the leaderboard.
 */
export const nftSnapshot = pgTable(
  "NftSnapshot",
  {
    id: text("id").primaryKey(),
    userId: text("userId").notNull(),
    walletAddress: text("walletAddress"),
    rank: integer("rank").notNull(),
    points: integer("points").notNull(),
    snapshotTakenAt: timestamp("snapshotTakenAt", { mode: "date" }).notNull(),
    hasMinted: boolean("hasMinted").notNull().default(false),
    mintedTokenId: integer("mintedTokenId"),
    mintedAt: timestamp("mintedAt", { mode: "date" }),
    mintTxHash: text("mintTxHash"),
  },
  (table) => [
    unique("NftSnapshot_userId_key").on(table.userId),
    // Note: rank is NOT unique - it changes frequently during updates
    index("NftSnapshot_walletAddress_idx").on(table.walletAddress),
    index("NftSnapshot_hasMinted_idx").on(table.hasMinted),
    index("NftSnapshot_rank_idx").on(table.rank),
  ],
);

// Relations
export const nftCollectionRelations = relations(nftCollection, ({ one }) => ({
  ownership: one(nftOwnership, {
    fields: [nftCollection.tokenId],
    references: [nftOwnership.tokenId],
  }),
  claim: one(nftClaims, {
    fields: [nftCollection.tokenId],
    references: [nftClaims.tokenId],
  }),
}));

export const nftOwnershipRelations = relations(nftOwnership, ({ one }) => ({
  nft: one(nftCollection, {
    fields: [nftOwnership.tokenId],
    references: [nftCollection.tokenId],
  }),
  user: one(users, {
    fields: [nftOwnership.userId],
    references: [users.id],
  }),
}));

export const nftClaimsRelations = relations(nftClaims, ({ one }) => ({
  nft: one(nftCollection, {
    fields: [nftClaims.tokenId],
    references: [nftCollection.tokenId],
  }),
  claimer: one(users, {
    fields: [nftClaims.claimerUserId],
    references: [users.id],
  }),
}));

export const nftSnapshotRelations = relations(nftSnapshot, ({ one }) => ({
  user: one(users, {
    fields: [nftSnapshot.userId],
    references: [users.id],
  }),
}));
