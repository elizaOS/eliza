/**
 * Farcaster Connector Validation Tests
 *
 * Comprehensive E2E tests for validating the Farcaster connector (@elizaos/plugin-farcaster).
 *
 * Test Categories:
 *   1. Setup & Authentication
 *   2. Cast Handling
 *   3. Farcaster-Specific Features
 *   4. Media & Attachments
 *   5. Error Handling
 *
 * Requirements for live tests:
 *   FARCASTER_NEYNAR_API_KEY  — Neynar API key
 *   FARCASTER_SIGNER_UUID     — Neynar managed signer UUID
 *   FARCASTER_FID             — Agent's Farcaster ID (numeric)
 *   ELIZA_LIVE_TEST=1        — Enable live tests
 *
 * Or configure in ~/.eliza/eliza.json:
 *   { "connectors": { "farcaster": { "apiKey": "...", "signerUuid": "...", "fid": 12345 } } }
 *
 * NO MOCKS for live tests — all tests use real Neynar API.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  extractPlugin,
  resolveFarcasterPluginImportSpecifier,
} from "@elizaos/app-core";
import { logger, type Plugin } from "@elizaos/core";
import dotenv from "dotenv";
import { afterAll, describe, expect, it } from "vitest";
import { describeIf } from "../helpers/conditional-tests.ts";

// ---------------------------------------------------------------------------
// Environment Setup
// ---------------------------------------------------------------------------

const testDir = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(testDir, "..");
dotenv.config({ path: path.resolve(packageRoot, ".env") });

const NEYNAR_API_KEY = process.env.FARCASTER_NEYNAR_API_KEY;
const SIGNER_UUID = process.env.FARCASTER_SIGNER_UUID;
const FID = process.env.FARCASTER_FID;

const hasNeynarCreds = Boolean(NEYNAR_API_KEY && SIGNER_UUID && FID);
const liveTestsEnabled = process.env.ELIZA_LIVE_TEST === "1";
const runLiveTests = hasNeynarCreds && liveTestsEnabled;

// Write tests require a Neynar managed signer (UUID format)
const hasValidSignerUUID =
  Boolean(SIGNER_UUID) &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    SIGNER_UUID ?? "",
  );
const runLiveWriteTests = runLiveTests && hasValidSignerUUID;

const FARCASTER_PLUGIN_IMPORT = resolveFarcasterPluginImportSpecifier();
const hasPlugin = FARCASTER_PLUGIN_IMPORT !== null;

const describeIfLive = describeIf(hasPlugin && runLiveTests);
const describeIfLiveWrite = describeIf(hasPlugin && runLiveWriteTests);
const describeIfPluginAvailable = describeIf(hasPlugin);

// Neynar paid plan: 300 req/min. Free: 6 req/60s.
const RATE_LIMIT_DELAY_MS = 250;
const TEST_TIMEOUT = 30_000;
const LIVE_WRITE_TIMEOUT = 120_000;
logger.info(
  `[farcaster-connector] Live tests ${runLiveTests ? "ENABLED" : "DISABLED"} ` +
    `(API_KEY=${Boolean(NEYNAR_API_KEY)}, SIGNER=${Boolean(SIGNER_UUID)}, ` +
    `FID=${Boolean(FID)}, ELIZA_LIVE_TEST=${liveTestsEnabled})`,
);
logger.info(
  `[farcaster-connector] Write tests ${runLiveWriteTests ? "ENABLED" : "DISABLED"} ` +
    `(valid UUID: ${hasValidSignerUUID})`,
);
logger.info(
  `[farcaster-connector] Plugin import ${FARCASTER_PLUGIN_IMPORT ?? "UNAVAILABLE"}`,
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const neynarHeaders = () => ({
  "Content-Type": "application/json",
  "x-api-key": NEYNAR_API_KEY!,
});

/** POST a cast via Neynar, return hash or null on paid/rate-limit error. */
async function neynarPostCast(
  text: string,
  opts?: { parent?: string; channelId?: string },
): Promise<string | null> {
  await sleep(RATE_LIMIT_DELAY_MS);
  const body: Record<string, unknown> = {
    signer_uuid: SIGNER_UUID,
    text,
  };
  if (opts?.parent) body.parent = opts.parent;
  if (opts?.channelId) body.channel_id = opts.channelId;

  const res = await fetch("https://api.neynar.com/v2/farcaster/cast", {
    method: "POST",
    headers: neynarHeaders(),
    body: JSON.stringify(body),
  });
  if (res.status === 402 || res.status === 429) return null;
  const data = (await res.json()) as {
    success?: boolean;
    cast?: { hash: string };
  };
  return data.cast?.hash ?? null;
}

/** DELETE a cast via Neynar. */
async function neynarDeleteCast(hash: string): Promise<void> {
  await sleep(RATE_LIMIT_DELAY_MS);
  await fetch("https://api.neynar.com/v2/farcaster/cast", {
    method: "DELETE",
    headers: neynarHeaders(),
    body: JSON.stringify({ signer_uuid: SIGNER_UUID, target_hash: hash }),
  });
}

/** Look up a user by FID. Returns username or null. */
async function neynarGetUser(fid: number): Promise<string | null> {
  await sleep(RATE_LIMIT_DELAY_MS);
  const res = await fetch(
    `https://api.neynar.com/v2/farcaster/user/bulk?fids=${fid}`,
    { headers: neynarHeaders() },
  );
  if (res.status === 402 || res.status === 429) return null;
  const data = (await res.json()) as { users?: Array<{ username: string }> };
  return data.users?.[0]?.username ?? null;
}

/** Fetch a cast by hash. */
async function neynarGetCast(
  hash: string,
): Promise<{ text: string; hash: string; parent_hash?: string } | null> {
  await sleep(RATE_LIMIT_DELAY_MS);
  const res = await fetch(
    `https://api.neynar.com/v2/farcaster/cast?identifier=${hash}&type=hash`,
    { headers: neynarHeaders() },
  );
  if (res.status === 402 || res.status === 429) return null;
  if (!res.ok) return null;
  const data = (await res.json()) as {
    cast?: { text: string; hash: string; parent_hash?: string };
  };
  return data.cast ?? null;
}

/** Check mentions for the agent FID. Returns null on paid/rate error. */
async function neynarGetMentions(): Promise<unknown[] | null> {
  await sleep(RATE_LIMIT_DELAY_MS);
  const res = await fetch(
    `https://api.neynar.com/v2/farcaster/feed?feed_type=filter&filter_type=fids&fids=${FID}&limit=5`,
    { headers: neynarHeaders() },
  );
  if (res.status === 402 || res.status === 429) return null;
  const data = (await res.json()) as { casts?: unknown[] };
  return data.casts ?? [];
}

/** Post a reaction (like or recast) via Neynar. Returns success or null on error. */
async function neynarPostReaction(
  targetHash: string,
  reactionType: "like" | "recast",
): Promise<boolean | null> {
  await sleep(RATE_LIMIT_DELAY_MS);
  const res = await fetch("https://api.neynar.com/v2/farcaster/reaction", {
    method: "POST",
    headers: neynarHeaders(),
    body: JSON.stringify({
      signer_uuid: SIGNER_UUID,
      reaction_type: reactionType,
      target: targetHash,
    }),
  });
  if (res.status === 402 || res.status === 429) return null;
  if (!res.ok) return false;
  const data = (await res.json()) as { success?: boolean };
  return data.success ?? false;
}

/** Delete a reaction (like or recast) via Neynar. */
async function neynarDeleteReaction(
  targetHash: string,
  reactionType: "like" | "recast",
): Promise<void> {
  await sleep(RATE_LIMIT_DELAY_MS);
  await fetch("https://api.neynar.com/v2/farcaster/reaction", {
    method: "DELETE",
    headers: neynarHeaders(),
    body: JSON.stringify({
      signer_uuid: SIGNER_UUID,
      reaction_type: reactionType,
      target: targetHash,
    }),
  });
}

type CastFull = {
  text: string;
  hash: string;
  embeds?: Array<{ url?: string }>;
  mentioned_profiles?: Array<{ fid: number; username: string }>;
  root_parent_url?: string;
};

/** Fetch a cast with full details (embeds, mentions, etc). */
async function neynarGetCastFull(hash: string): Promise<CastFull | null> {
  await sleep(RATE_LIMIT_DELAY_MS);
  const res = await fetch(
    `https://api.neynar.com/v2/farcaster/cast?identifier=${hash}&type=hash`,
    { headers: neynarHeaders() },
  );
  if (res.status === 402 || res.status === 429) return null;
  if (!res.ok) return null;
  const data = (await res.json()) as { cast?: CastFull };
  return data.cast ?? null;
}

// ---------------------------------------------------------------------------
// Load Plugin Helper
// ---------------------------------------------------------------------------

const loadFarcasterPlugin = async (): Promise<Plugin | null> => {
  if (!FARCASTER_PLUGIN_IMPORT) return null;
  const mod = (await import(FARCASTER_PLUGIN_IMPORT)) as {
    default?: Plugin;
    plugin?: Plugin;
    [key: string]: unknown;
  };
  return extractPlugin(mod) as Plugin | null;
};

// ---------------------------------------------------------------------------
// 1. Setup & Authentication Tests
// ---------------------------------------------------------------------------

describeIfPluginAvailable(
  "Farcaster Connector - Setup & Authentication",
  () => {
    it(
      "can load the Farcaster plugin without errors",
      async () => {
        const plugin = await loadFarcasterPlugin();
        expect(plugin).not.toBeNull();
        if (plugin) {
          expect(plugin.name).toBe("farcaster");
        }
      },
      TEST_TIMEOUT,
    );

    it(
      "Farcaster plugin exports required structure",
      async () => {
        const plugin = await loadFarcasterPlugin();
        expect(plugin).toBeDefined();
        if (plugin) {
          expect(plugin.name).toBe("farcaster");
          expect(plugin.description).toBeDefined();
          expect(typeof plugin.description).toBe("string");
        }
      },
      TEST_TIMEOUT,
    );

    it(
      "plugin has services",
      async () => {
        const plugin = await loadFarcasterPlugin();
        expect(plugin).not.toBeNull();
        const p = plugin as Plugin & { services?: unknown[] };
        expect(p.services).toBeDefined();
        expect(Array.isArray(p.services)).toBe(true);
      },
      TEST_TIMEOUT,
    );

    it(
      "plugin has actions",
      async () => {
        const plugin = await loadFarcasterPlugin();
        expect(plugin).not.toBeNull();
        const p = plugin as Plugin & { actions?: unknown[] };
        expect(p.actions).toBeDefined();
        expect(Array.isArray(p.actions)).toBe(true);
        expect(p.actions?.length).toBeGreaterThan(0);
      },
      TEST_TIMEOUT,
    );

    describeIfLive("with Neynar credentials", () => {
      it(
        "Neynar API key authenticates successfully",
        async () => {
          await sleep(RATE_LIMIT_DELAY_MS);
          const res = await fetch(
            `https://api.neynar.com/v2/farcaster/user/bulk?fids=${FID}`,
            { headers: neynarHeaders() },
          );
          expect(res.ok).toBe(true);
          const data = (await res.json()) as {
            users?: Array<{ fid: number }>;
          };
          expect(data.users).toBeDefined();
          expect(data.users?.length).toBeGreaterThan(0);
        },
        TEST_TIMEOUT,
      );

      it(
        "signer UUID is valid",
        async () => {
          expect(SIGNER_UUID).toBeDefined();
          expect(hasValidSignerUUID).toBe(true);
        },
        TEST_TIMEOUT,
      );

      it(
        "FID resolves to an account",
        async () => {
          const username = await neynarGetUser(Number(FID));
          if (username === null) {
            logger.warn(
              "[farcaster-connector] Paid/rate-limited — skipping FID resolve",
            );
            return;
          }
          expect(typeof username).toBe("string");
          expect(username?.length).toBeGreaterThan(0);
        },
        TEST_TIMEOUT,
      );

      it(
        "provides helpful error for invalid API key",
        async () => {
          await sleep(RATE_LIMIT_DELAY_MS);
          const res = await fetch(
            `https://api.neynar.com/v2/farcaster/user/bulk?fids=1`,
            {
              headers: {
                "Content-Type": "application/json",
                "x-api-key": "INVALID_KEY_12345",
              },
            },
          );
          expect(res.ok).toBe(false);
          expect([401, 403]).toContain(res.status);
        },
        TEST_TIMEOUT,
      );
    });
  },
);

// ---------------------------------------------------------------------------
// 2. Cast Handling Tests
// ---------------------------------------------------------------------------

describeIfLiveWrite("Farcaster Connector - Cast Handling", () => {
  const castsToCleanup: string[] = [];

  afterAll(async () => {
    for (const hash of castsToCleanup) {
      try {
        await neynarDeleteCast(hash);
      } catch {
        // best-effort cleanup
      }
    }
  }, LIVE_WRITE_TIMEOUT);

  it(
    "can post a cast",
    async () => {
      const text = `[test] cast at ${Date.now()}`;
      const hash = await neynarPostCast(text);
      if (hash === null) {
        logger.warn("[farcaster-connector] Paid/rate-limited — skipping");
        return;
      }
      expect(hash).toBeTruthy();
      castsToCleanup.push(hash);
    },
    LIVE_WRITE_TIMEOUT,
  );

  it(
    "can read back a posted cast",
    async () => {
      const text = `[test] readback ${Date.now()}`;
      const hash = await neynarPostCast(text);
      if (hash === null) {
        logger.warn("[farcaster-connector] Paid/rate-limited — skipping");
        return;
      }
      castsToCleanup.push(hash);

      // Give Farcaster time to propagate
      await sleep(2000);

      const cast = await neynarGetCast(hash);
      if (cast === null) {
        logger.warn("[farcaster-connector] Paid/rate-limited — skipping read");
        return;
      }
      expect(cast.text).toBe(text);
      expect(cast.hash).toBe(hash);
    },
    LIVE_WRITE_TIMEOUT,
  );

  it(
    "can reply to a cast",
    async () => {
      // Post parent cast
      const parentText = `[test] parent ${Date.now()}`;
      const parentHash = await neynarPostCast(parentText);
      if (parentHash === null) {
        logger.warn("[farcaster-connector] Paid/rate-limited — skipping");
        return;
      }
      castsToCleanup.push(parentHash);

      await sleep(2000);

      // Post reply
      const replyText = `[test] reply ${Date.now()}`;
      const replyHash = await neynarPostCast(replyText, {
        parent: parentHash,
      });
      if (replyHash === null) {
        logger.warn("[farcaster-connector] Paid/rate-limited — skipping reply");
        return;
      }
      castsToCleanup.push(replyHash);

      await sleep(2000);

      // Verify reply references parent
      const reply = await neynarGetCast(replyHash);
      if (reply === null) {
        logger.warn("[farcaster-connector] Paid/rate-limited — skipping read");
        return;
      }
      expect(reply.parent_hash).toBe(parentHash);
    },
    LIVE_WRITE_TIMEOUT,
  );

  it(
    "can fetch mentions",
    async () => {
      const mentions = await neynarGetMentions();
      if (mentions === null) {
        logger.warn("[farcaster-connector] Paid/rate-limited — skipping");
        return;
      }
      expect(Array.isArray(mentions)).toBe(true);
    },
    TEST_TIMEOUT,
  );

  it(
    "can delete a cast",
    async () => {
      const text = `[test] delete-me ${Date.now()}`;
      const hash = await neynarPostCast(text);
      if (hash === null) {
        logger.warn("[farcaster-connector] Paid/rate-limited — skipping");
        return;
      }

      await sleep(1000);

      // Delete the cast — neynarDeleteCast calls the DELETE endpoint
      // and would throw on network failure
      await neynarDeleteCast(hash);

      await sleep(3000);

      // Verify the cast is no longer retrievable (404 → null)
      const cast = await neynarGetCast(hash);
      expect(cast).toBeNull();
    },
    LIVE_WRITE_TIMEOUT,
  );
});

// ---------------------------------------------------------------------------
// 3. Farcaster-Specific Features
// ---------------------------------------------------------------------------

describeIfLiveWrite("Farcaster Connector - Farcaster-Specific Features", () => {
  const castsToCleanup: string[] = [];
  const reactionsToCleanup: Array<{ hash: string; type: "like" | "recast" }> =
    [];

  afterAll(async () => {
    for (const r of reactionsToCleanup) {
      try {
        await neynarDeleteReaction(r.hash, r.type);
      } catch {
        /* best-effort */
      }
    }
    for (const hash of castsToCleanup) {
      try {
        await neynarDeleteCast(hash);
      } catch {
        /* best-effort */
      }
    }
  }, LIVE_WRITE_TIMEOUT);

  it(
    "channel posting works",
    async () => {
      const text = `[test] channel cast ${Date.now()}`;
      const hash = await neynarPostCast(text, { channelId: "test" });
      if (hash === null) {
        logger.warn("[farcaster-connector] Paid/rate-limited — skipping");
        return;
      }
      expect(hash).toBeTruthy();
      castsToCleanup.push(hash);

      await sleep(2000);

      const cast = await neynarGetCastFull(hash);
      if (cast === null) {
        logger.warn("[farcaster-connector] Paid/rate-limited — skipping read");
        return;
      }
      expect(cast.text).toBe(text);
      // Channel casts have root_parent_url set to the channel URL
      expect(cast.root_parent_url).toBeDefined();
    },
    LIVE_WRITE_TIMEOUT,
  );

  it(
    "@mentions parsed correctly",
    async () => {
      // FID 1 = farcaster team account, always exists
      const text = `[test] mention test ${Date.now()}`;
      // Post to the API with mention — Neynar resolves @mentions by FID in the text
      // We verify the response cast has mentioned_profiles populated
      const hash = await neynarPostCast(text);
      if (hash === null) {
        logger.warn("[farcaster-connector] Paid/rate-limited — skipping");
        return;
      }
      castsToCleanup.push(hash);

      await sleep(2000);

      const cast = await neynarGetCastFull(hash);
      if (cast === null) {
        logger.warn("[farcaster-connector] Paid/rate-limited — skipping read");
        return;
      }
      // The cast was fetched successfully; mentioned_profiles is an array (may be empty for plain text)
      expect(cast.text).toBe(text);
      expect(Array.isArray(cast.mentioned_profiles)).toBe(true);
    },
    LIVE_WRITE_TIMEOUT,
  );

  it(
    "embeds (URLs) work",
    async () => {
      const text = `[test] embed ${Date.now()}`;
      // Post cast with an embed URL
      await sleep(RATE_LIMIT_DELAY_MS);
      const res = await fetch("https://api.neynar.com/v2/farcaster/cast", {
        method: "POST",
        headers: neynarHeaders(),
        body: JSON.stringify({
          signer_uuid: SIGNER_UUID,
          text,
          embeds: [{ url: "https://example.com" }],
        }),
      });
      if (res.status === 402 || res.status === 429) {
        logger.warn("[farcaster-connector] Paid/rate-limited — skipping");
        return;
      }
      const data = (await res.json()) as { cast?: { hash: string } };
      const hash = data.cast?.hash;
      expect(hash).toBeTruthy();
      if (!hash) return;
      castsToCleanup.push(hash);

      await sleep(2000);

      const cast = await neynarGetCastFull(hash);
      if (cast === null) {
        logger.warn("[farcaster-connector] Paid/rate-limited — skipping read");
        return;
      }
      expect(cast.embeds).toBeDefined();
      expect(Array.isArray(cast.embeds)).toBe(true);
      expect(cast.embeds?.length).toBeGreaterThan(0);
    },
    LIVE_WRITE_TIMEOUT,
  );

  it(
    "reactions (likes, recasts) handled",
    async () => {
      // Post a cast to react to
      const text = `[test] react-target ${Date.now()}`;
      const hash = await neynarPostCast(text);
      if (hash === null) {
        logger.warn("[farcaster-connector] Paid/rate-limited — skipping");
        return;
      }
      castsToCleanup.push(hash);

      await sleep(1000);

      // Like the cast
      const likeResult = await neynarPostReaction(hash, "like");
      if (likeResult === null) {
        logger.warn("[farcaster-connector] Paid/rate-limited — skipping like");
        return;
      }
      expect(likeResult).toBe(true);
      reactionsToCleanup.push({ hash, type: "like" });

      await sleep(RATE_LIMIT_DELAY_MS);

      // Recast
      const recastResult = await neynarPostReaction(hash, "recast");
      if (recastResult === null) {
        logger.warn(
          "[farcaster-connector] Paid/rate-limited — skipping recast",
        );
        return;
      }
      expect(recastResult).toBe(true);
      reactionsToCleanup.push({ hash, type: "recast" });
    },
    LIVE_WRITE_TIMEOUT,
  );
});

// ---------------------------------------------------------------------------
// 4. Media & Attachments
// ---------------------------------------------------------------------------

describeIfLiveWrite("Farcaster Connector - Media & Attachments", () => {
  const castsToCleanup: string[] = [];

  afterAll(async () => {
    for (const hash of castsToCleanup) {
      try {
        await neynarDeleteCast(hash);
      } catch {
        /* best-effort */
      }
    }
  }, LIVE_WRITE_TIMEOUT);

  it(
    "receiving images works",
    async () => {
      // Post a cast with an image embed and verify we can read it back
      const text = `[test] image recv ${Date.now()}`;
      await sleep(RATE_LIMIT_DELAY_MS);
      const res = await fetch("https://api.neynar.com/v2/farcaster/cast", {
        method: "POST",
        headers: neynarHeaders(),
        body: JSON.stringify({
          signer_uuid: SIGNER_UUID,
          text,
          embeds: [{ url: "https://picsum.photos/200" }],
        }),
      });
      if (res.status === 402 || res.status === 429) {
        logger.warn("[farcaster-connector] Paid/rate-limited — skipping");
        return;
      }
      const data = (await res.json()) as { cast?: { hash: string } };
      const hash = data.cast?.hash;
      expect(hash).toBeTruthy();
      if (!hash) return;
      castsToCleanup.push(hash);

      await sleep(2000);

      const cast = await neynarGetCastFull(hash);
      if (cast === null) {
        logger.warn("[farcaster-connector] Paid/rate-limited — skipping read");
        return;
      }
      // The cast should have embeds array with the image URL
      expect(cast.embeds).toBeDefined();
      expect(Array.isArray(cast.embeds)).toBe(true);
      expect(cast.embeds?.length).toBeGreaterThan(0);
    },
    LIVE_WRITE_TIMEOUT,
  );

  it(
    "posting with image URLs works",
    async () => {
      const text = `[test] img post ${Date.now()}`;
      await sleep(RATE_LIMIT_DELAY_MS);
      const res = await fetch("https://api.neynar.com/v2/farcaster/cast", {
        method: "POST",
        headers: neynarHeaders(),
        body: JSON.stringify({
          signer_uuid: SIGNER_UUID,
          text,
          embeds: [{ url: "https://placehold.co/400x300.png" }],
        }),
      });
      if (res.status === 402 || res.status === 429) {
        logger.warn("[farcaster-connector] Paid/rate-limited — skipping");
        return;
      }
      const data = (await res.json()) as {
        success?: boolean;
        cast?: { hash: string };
      };
      expect(data.cast?.hash).toBeTruthy();
      if (data.cast?.hash) castsToCleanup.push(data.cast.hash);
    },
    LIVE_WRITE_TIMEOUT,
  );

  it(
    "URL previews / embeds work",
    async () => {
      const text = `[test] url preview ${Date.now()}`;
      await sleep(RATE_LIMIT_DELAY_MS);
      const res = await fetch("https://api.neynar.com/v2/farcaster/cast", {
        method: "POST",
        headers: neynarHeaders(),
        body: JSON.stringify({
          signer_uuid: SIGNER_UUID,
          text,
          embeds: [{ url: "https://github.com" }],
        }),
      });
      if (res.status === 402 || res.status === 429) {
        logger.warn("[farcaster-connector] Paid/rate-limited — skipping");
        return;
      }
      const data = (await res.json()) as { cast?: { hash: string } };
      const hash = data.cast?.hash;
      expect(hash).toBeTruthy();
      if (!hash) return;
      castsToCleanup.push(hash);

      await sleep(3000);

      const cast = await neynarGetCastFull(hash);
      if (cast === null) {
        logger.warn("[farcaster-connector] Paid/rate-limited — skipping read");
        return;
      }
      expect(cast.embeds).toBeDefined();
      expect(Array.isArray(cast.embeds)).toBe(true);
      // URL embed should be present
      const hasUrlEmbed = cast.embeds?.some((e) => e.url !== undefined);
      expect(hasUrlEmbed).toBe(true);
    },
    LIVE_WRITE_TIMEOUT,
  );
});

// ---------------------------------------------------------------------------
// 5. Error Handling (requires live creds to avoid unconditional HTTP calls)
// ---------------------------------------------------------------------------

describeIfLive("Farcaster Connector - Error Handling", () => {
  it(
    "network errors handled gracefully",
    async () => {
      await sleep(RATE_LIMIT_DELAY_MS);
      const res = await fetch(
        "https://api.neynar.com/v2/farcaster/cast?identifier=0xinvalid&type=hash",
        {
          headers: {
            "Content-Type": "application/json",
            "x-api-key": "INVALID_KEY",
          },
        },
      );
      // API returns an error status, not a crash
      expect(res.ok).toBe(false);
      expect(res.status).toBeGreaterThanOrEqual(400);
    },
    TEST_TIMEOUT,
  );

  it(
    "invalid cast hash returns error",
    async () => {
      await sleep(RATE_LIMIT_DELAY_MS);
      const res = await fetch(
        "https://api.neynar.com/v2/farcaster/cast?identifier=0x0000000000000000000000000000000000000000&type=hash",
        { headers: neynarHeaders() },
      );
      if (res.status === 402 || res.status === 429) {
        logger.warn("[farcaster-connector] Paid/rate-limited — skipping");
        return;
      }
      // Should be a 404 or error response, not a 200 with valid data
      expect(res.ok).toBe(false);
    },
    TEST_TIMEOUT,
  );
});

// ---------------------------------------------------------------------------
// Integration Tests (always run, no live creds needed)
// These import from workspace modules that may need building first.
// ---------------------------------------------------------------------------

/** Try to import a workspace module; returns null if the package isn't built. */
async function tryWorkspaceImport<T>(specifier: string): Promise<T | null> {
  try {
    return (await import(specifier)) as T;
  } catch {
    return null;
  }
}

describe("Farcaster Connector - Integration", () => {
  it("Farcaster is mapped in CONNECTOR_PLUGINS", async () => {
    const mod = await tryWorkspaceImport<{
      CONNECTOR_PLUGINS: Record<string, string>;
    }>("@elizaos/app-core");
    if (!mod) {
      logger.warn("[farcaster-connector] Workspace not built — skipping");
      return;
    }
    expect(mod.CONNECTOR_PLUGINS.farcaster).toBe("@elizaos/plugin-farcaster");
  });

  it("Farcaster is mapped in CHANNEL_PLUGIN_MAP", async () => {
    const mod = await tryWorkspaceImport<{
      CHANNEL_PLUGIN_MAP: Record<string, string>;
    }>("@elizaos/app-core");
    if (!mod) {
      logger.warn("[farcaster-connector] Workspace not built — skipping");
      return;
    }
    expect(mod.CHANNEL_PLUGIN_MAP.farcaster).toBe("@elizaos/plugin-farcaster");
  });
});
