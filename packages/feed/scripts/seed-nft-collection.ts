#!/usr/bin/env bun

/**
 * NFT Collection Seed Script
 *
 * Seeds development NFT collection data for testing.
 * Creates 100 NFT entries with generated images and stories.
 *
 * Usage:
 *   bun run scripts/seed-nft-collection.ts              # Seed if empty
 *   bun run scripts/seed-nft-collection.ts --force      # Force reseed (clears existing)
 *   bun run scripts/seed-nft-collection.ts --stats      # Show collection stats
 *   bun run scripts/seed-nft-collection.ts --snapshot   # Take a leaderboard snapshot
 */

import { PointsService } from "@feed/api";
import {
  closeDatabase,
  count,
  db,
  eq,
  nftClaims,
  nftCollection,
  nftOwnership,
  nftSnapshot,
} from "@feed/db";
import { logger } from "@feed/shared";
import { nanoid } from "nanoid";

const TOTAL_NFTS = 100;

// Use environment variables if set, otherwise fall back to local-dev sentinels.
// Default chain IDs: 1 = Ethereum Mainnet, 11155111 = Sepolia, 31337 = Local
const NFT_CONTRACT_ADDRESS =
  process.env.NFT_CONTRACT_ADDRESS ??
  "0x0000000000000000000000000000000000000000";
const configuredChainIdRaw =
  process.env.NEXT_PUBLIC_CHAIN_ID ||
  process.env.CHAIN_ID ||
  process.env.NFT_CHAIN_ID;
const NFT_CHAIN_ID = configuredChainIdRaw
  ? parseInt(configuredChainIdRaw, 10)
  : 31337; // Default to local Hardhat

/** IPFS CID for NFT metadata (contains {tokenId}.json files, required) */
const IPFS_METADATA_CID = process.env.NFT_IPFS_METADATA_CID;

/** IPFS gateway for fetching metadata during seeding */
const IPFS_GATEWAY = "https://ipfs.io/ipfs";

// Image URLs use the image proxy endpoint (which fetches from IPFS and caches via CDN)
const getImageUrl = (tokenId: number) => `/api/nft/image/${tokenId}`;
const getThumbnailUrl = (tokenId: number) => `/api/nft/image/${tokenId}`;

/** Fetch metadata from IPFS for a given token ID */
async function fetchIpfsMetadata(tokenId: number): Promise<{
  name: string;
  description: string;
  attributes: Array<{ trait_type: string; value: string | number }>;
} | null> {
  if (!IPFS_METADATA_CID) {
    return null;
  }

  try {
    const url = `${IPFS_GATEWAY}/${IPFS_METADATA_CID}/${tokenId}.json`;
    const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) return null;
    const data = (await response.json()) as {
      name?: string;
      description?: string;
      attributes?: Array<{ trait_type: string; value: string | number }>;
    };
    // Use the "Name" trait as the NFT name (e.g. "WireMonkey"), fall back to top-level name
    const nameTrait = data.attributes?.find((a) => a.trait_type === "Name");
    const name =
      typeof nameTrait?.value === "string"
        ? nameTrait.value
        : (data.name ?? `Feed #${tokenId}`);
    return {
      name,
      description: data.description ?? "",
      attributes: data.attributes ?? [],
    };
  } catch {
    return null;
  }
}

// Mythological/fantasy names for NFTs
const nftNames = [
  "The Oracle of Genesis",
  "Keeper of the Flame",
  "Shadow Walker",
  "The Last Prophet",
  "Echoes of Eternity",
  "Guardian of the Void",
  "Weaver of Dreams",
  "The Silent Watcher",
  "Bearer of Light",
  "The Eternal Wanderer",
  "Whispers in the Dark",
  "The Forgotten One",
  "Bringer of Dawn",
  "The Obsidian Crown",
  "Seeker of Truth",
  "The Crimson Tide",
  "Master of Shadows",
  "The Azure Phoenix",
  "Herald of Change",
  "The Golden Serpent",
  "Keeper of Secrets",
  "The Iron Will",
  "Dancer in Flames",
  "The Silver Moon",
  "Voice of Thunder",
  "The Jade Emperor",
  "Walker Between Worlds",
  "The Sapphire Queen",
  "Harbinger of Storms",
  "The Ruby Knight",
  "Speaker of Stars",
  "The Emerald Sage",
  "Rider of Winds",
  "The Amethyst Oracle",
  "Breaker of Chains",
  "The Topaz Hunter",
  "Singer of Souls",
  "The Pearl Maiden",
  "Caller of Ravens",
  "The Onyx Guardian",
  "Sculptor of Fate",
  "The Opal Dreamer",
  "Tamer of Beasts",
  "The Garnet Warrior",
  "Painter of Worlds",
  "The Moonstone Seer",
  "Welder of Elements",
  "The Sunstone King",
  "Keeper of Time",
  "The Bloodstone Heir",
  "Dancer of Shadows",
  "The Starstone Child",
  "Binder of Realms",
  "The Flamestone Lord",
  "Reader of Bones",
  "The Icestone Queen",
  "Shaper of Mountains",
  "The Stormstone Rider",
  "Caller of Spirits",
  "The Earthstone Titan",
  "Singer of Silence",
  "The Windstone Oracle",
  "Walker of Dreams",
  "The Voidstone Mage",
  "Keeper of Balance",
  "The Lightstone Angel",
  "Breaker of Curses",
  "The Darkstone Demon",
  "Healer of Wounds",
  "The Lifestone Druid",
  "Destroyer of Worlds",
  "The Deathstone Knight",
  "Creator of Life",
  "The Soulstone Witch",
  "Guardian of Gates",
  "The Mindstone Sage",
  "Master of Illusions",
  "The Heartstone King",
  "Wielder of Chaos",
  "The Orderstone Queen",
  "Seeker of Power",
  "The Wisdomstone Elder",
  "Bringer of Justice",
  "The Mercystone Healer",
  "Voice of the Ancients",
  "The Wrathstone Berserker",
  "Keeper of Promises",
  "The Hopestore Saint",
  "Bearer of Destiny",
  "The Fatestone Oracle",
  "Walker of Paths",
  "The Choicestone Guide",
  "Dancer in Starlight",
  "The Cosmicstone Voyager",
  "Singer of Creation",
  "The Genesisstone First",
  "Keeper of Endings",
  "The Omegastone Last",
  "The Alpha and Omega",
  "The Infinitestone One",
];

// Story fragments for NFTs
const storyTemplates = [
  "Born from the primordial chaos, this being witnessed the birth of stars and the death of gods.",
  "In the ancient texts, they speak of a figure who walked between worlds, never staying long enough to leave a shadow.",
  "The prophecy foretold their coming - a harbinger of change that would reshape the very fabric of reality.",
  "Deep within the forgotten temples, their name is whispered with reverence and fear.",
  "They say on moonless nights, you can still hear the echoes of their footsteps across the endless void.",
  "Once mortal, they transcended the boundaries of existence to become something both less and more than human.",
  "The chronicles record their deeds in languages that no longer have speakers.",
  "From the ashes of the old world, they arose to guide the lost and illuminate the path forward.",
  "Their power is matched only by their wisdom, earned through millennia of silent observation.",
  "The cosmos itself bends to their will, for they are the bridge between what was and what shall be.",
];

interface SeedStats {
  totalNfts: number;
  ownedCount: number;
  claimedCount: number;
  snapshotCount: number;
}

export interface RunNftCollectionSeedOptions {
  forceReseed?: boolean;
  showStats?: boolean;
  takeSnapshot?: boolean;
  closeAfter?: boolean;
}

async function getStats(): Promise<SeedStats> {
  const [nftCount] = await db.select({ count: count() }).from(nftCollection);
  const [ownedCount] = await db.select({ count: count() }).from(nftOwnership);
  const [claimedCount] = await db.select({ count: count() }).from(nftClaims);
  const [snapshotCount] = await db.select({ count: count() }).from(nftSnapshot);

  return {
    totalNfts: nftCount?.count ?? 0,
    ownedCount: ownedCount?.count ?? 0,
    claimedCount: claimedCount?.count ?? 0,
    snapshotCount: snapshotCount?.count ?? 0,
  };
}

async function clearCollection(): Promise<void> {
  logger.info("Clearing existing NFT collection data...", undefined, "SeedNFT");

  await db.delete(nftClaims);
  await db.delete(nftOwnership);
  await db.delete(nftSnapshot);
  await db.delete(nftCollection);

  logger.info("Collection cleared", undefined, "SeedNFT");
}

async function seedCollection(): Promise<void> {
  logger.info(`Seeding ${TOTAL_NFTS} NFTs...`, undefined, "SeedNFT");
  logger.info("Fetching metadata from IPFS...", undefined, "SeedNFT");

  const now = new Date();

  for (let i = 0; i < TOTAL_NFTS; i++) {
    const tokenId = i + 1;

    // Try to fetch real metadata from IPFS, fall back to local names
    const ipfsMetadata = await fetchIpfsMetadata(tokenId);
    const name = ipfsMetadata?.name ?? nftNames[i] ?? `Feed #${tokenId}`;
    const description =
      ipfsMetadata?.description ??
      `A unique piece from the Feed Top 100 Collection. Token #${tokenId} of 100.`;
    const storyTemplate = storyTemplates[i % storyTemplates.length]!;

    await db.insert(nftCollection).values({
      id: nanoid(),
      tokenId,
      name,
      description,
      imageUrl: getImageUrl(tokenId),
      thumbnailUrl: getThumbnailUrl(tokenId),
      imageCid: null,
      storyTitle: name,
      storyContent: storyTemplate,
      metadataUri: IPFS_METADATA_CID
        ? `ipfs://${IPFS_METADATA_CID}/${tokenId}.json`
        : null,
      attributes: ipfsMetadata?.attributes ?? [
        { trait_type: "Collection", value: "Feed Top 100" },
        { trait_type: "Token Number", value: tokenId },
        { trait_type: "Edition", value: "Genesis" },
      ],
      contractAddress: NFT_CONTRACT_ADDRESS,
      chainId: NFT_CHAIN_ID,
      createdAt: now,
      updatedAt: now,
    });

    if (tokenId % 10 === 0) {
      logger.info(
        `Seeded ${tokenId}/${TOTAL_NFTS} NFTs${ipfsMetadata ? " (IPFS metadata)" : " (fallback names)"}`,
        undefined,
        "SeedNFT",
      );
    }
  }

  logger.info(`Successfully seeded ${TOTAL_NFTS} NFTs`, undefined, "SeedNFT");
}

async function takeLeaderboardSnapshot(): Promise<void> {
  logger.info(
    "Taking leaderboard snapshot for NFT eligibility...",
    undefined,
    "SeedNFT",
  );

  const snapshotTime = new Date();

  // Fetch top 100 users
  const leaderboardResult = await PointsService.getLeaderboard(
    1,
    100,
    0,
    "all",
  );
  const topUsers = leaderboardResult.users;

  logger.info(
    `Found ${topUsers.length} users for snapshot`,
    undefined,
    "SeedNFT",
  );

  // Clear existing snapshots (except those who have minted)
  const existingSnapshots = await db
    .select({
      userId: nftSnapshot.userId,
      hasMinted: nftSnapshot.hasMinted,
    })
    .from(nftSnapshot);

  const mintedUserIds = new Set(
    existingSnapshots.filter((s) => s.hasMinted).map((s) => s.userId),
  );

  // Delete non-minted snapshots
  for (const snapshot of existingSnapshots) {
    if (!snapshot.hasMinted) {
      await db
        .delete(nftSnapshot)
        .where(eq(nftSnapshot.userId, snapshot.userId));
    }
  }

  // Insert new snapshots
  for (let i = 0; i < topUsers.length; i++) {
    const user = topUsers[i]!;
    const rank = i + 1;

    // Skip if user has already minted
    if (mintedUserIds.has(user.id)) {
      continue;
    }

    await db.insert(nftSnapshot).values({
      id: nanoid(),
      userId: user.id,
      walletAddress: null, // Will be populated from users table
      rank,
      points: user.allPoints,
      snapshotTakenAt: snapshotTime,
      hasMinted: false,
    });
  }

  logger.info(
    `Snapshot complete: ${topUsers.length} users eligible (${mintedUserIds.size} already minted)`,
    { snapshotTime: snapshotTime.toISOString() },
    "SeedNFT",
  );
}

export async function runNftCollectionSeed(
  options: RunNftCollectionSeedOptions = {},
): Promise<void> {
  const {
    forceReseed = false,
    showStats = false,
    takeSnapshot = false,
    closeAfter = true,
  } = options;

  logger.info(
    "════════════════════════════════════════════════════════════",
    undefined,
    "SeedNFT",
  );
  logger.info(
    "Feed NFT Collection Seeder",
    { forceReseed, showStats, takeSnapshot },
    "SeedNFT",
  );
  logger.info(
    "════════════════════════════════════════════════════════════",
    undefined,
    "SeedNFT",
  );

  if (showStats) {
    const stats = await getStats();
    logger.info("NFT Collection Statistics", stats, "SeedNFT");
    if (closeAfter) {
      await closeDatabase();
    }
    return;
  }

  if (takeSnapshot) {
    await takeLeaderboardSnapshot();
    if (closeAfter) {
      await closeDatabase();
    }
    return;
  }

  const stats = await getStats();

  if (stats.totalNfts > 0 && !forceReseed) {
    logger.info(
      `Collection already seeded with ${stats.totalNfts} NFTs. Use --force to reseed.`,
      undefined,
      "SeedNFT",
    );
    if (closeAfter) {
      await closeDatabase();
    }
    return;
  }

  if (forceReseed && stats.totalNfts > 0) {
    await clearCollection();
  }

  await seedCollection();

  const finalStats = await getStats();
  logger.info("Seeding complete", finalStats, "SeedNFT");

  if (closeAfter) {
    await closeDatabase();
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  await runNftCollectionSeed({
    forceReseed: args.includes("--force"),
    showStats: args.includes("--stats"),
    takeSnapshot: args.includes("--snapshot"),
    closeAfter: true,
  });
}

if (import.meta.main) {
  main().catch((error) => {
    logger.error("Seeding failed", { error: String(error) }, "SeedNFT");
    process.exit(1);
  });
}
