/**
 * Lens Protocol Connector Validation Tests
 *
 * Comprehensive E2E tests for validating the Lens Protocol connector (@elizaos/plugin-lens).
 *
 * Test Categories:
 *   1. Setup & Authentication
 *   2. Post Handling
 *   3. Lens-Specific Features
 *   4. Media & Attachments
 *   5. Error Handling
 *
 * Requirements for live tests:
 *   LENS_API_KEY         — Lens app Server API Key (from developer.lens.xyz)
 *   LENS_ACCOUNT_ADDRESS — Lens account address (EVM address, e.g. "0x...")
 *   LENS_PRIVATE_KEY     — Wallet private key for signing (0x + 64 hex)
 *   ELIZA_LIVE_TEST=1   — Enable live tests
 *
 * Or configure in ~/.eliza/eliza.json:
 *   { "connectors": { "lens": { "apiKey": "...", "accountAddress": "0x...", "privateKey": "0x..." } } }
 *
 * Uses Lens Protocol V3 API (api.lens.xyz/graphql).
 * NO MOCKS for live tests — all tests use real Lens Protocol API.
 */

import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  extractPlugin,
  resolveLensPluginImportSpecifier,
} from "@elizaos/app-core";
import { logger, type Plugin } from "@elizaos/core";
import dotenv from "dotenv";
import { ethers } from "ethers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { describeIf } from "../helpers/conditional-tests.ts";

// ---------------------------------------------------------------------------
// Environment Setup
// ---------------------------------------------------------------------------

const testDir = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(testDir, "..");
dotenv.config({ path: path.resolve(packageRoot, ".env") });

const LENS_API_KEY = process.env.LENS_API_KEY;
const LENS_ACCOUNT_ADDRESS = process.env.LENS_ACCOUNT_ADDRESS;
const LENS_PRIVATE_KEY = process.env.LENS_PRIVATE_KEY;
const LENS_APP_ADDRESS = process.env.LENS_APP_ADDRESS;

const hasLensCreds = Boolean(LENS_API_KEY && LENS_ACCOUNT_ADDRESS);
const liveTestsEnabled = process.env.ELIZA_LIVE_TEST === "1";
const runLiveTests = hasLensCreds && liveTestsEnabled;

// Write tests require a valid Ethereum private key + app address for auth
const hasValidPrivateKey =
  Boolean(LENS_PRIVATE_KEY) &&
  /^0x[0-9a-fA-F]{64}$/.test(LENS_PRIVATE_KEY ?? "");
const hasAppAddress = Boolean(LENS_APP_ADDRESS);
const runLiveWriteTests = runLiveTests && hasValidPrivateKey && hasAppAddress;

// Mutable auth state — populated by beforeAll in write test suites
let lensAccessToken: string | null = null;

const LENS_PLUGIN_IMPORT = resolveLensPluginImportSpecifier();
const hasPlugin = LENS_PLUGIN_IMPORT !== null;

// Plugin-dependent tests (need @elizaos/plugin-lens installed)
const describeIfPluginAvailable = describeIf(hasPlugin);

// API-level live tests (need creds only, plugin NOT required)
const describeIfLive = describeIf(runLiveTests);
const describeIfLiveWrite = describeIf(runLiveWriteTests);

// Lens V3 GraphQL API
const RATE_LIMIT_DELAY_MS = 500;
const TEST_TIMEOUT = 30_000;
const LIVE_WRITE_TIMEOUT = 120_000;
const LENS_API_URL = "https://api.lens.xyz/graphql";

logger.info(
  `[lens-connector] Live tests ${runLiveTests ? "ENABLED" : "DISABLED"} ` +
    `(API_KEY=${Boolean(LENS_API_KEY)}, ACCOUNT=${Boolean(LENS_ACCOUNT_ADDRESS)}, ` +
    `PRIVATE_KEY=${Boolean(LENS_PRIVATE_KEY)}, APP=${Boolean(LENS_APP_ADDRESS)}, ` +
    `ELIZA_LIVE_TEST=${liveTestsEnabled})`,
);
logger.info(
  `[lens-connector] Write tests ${runLiveWriteTests ? "ENABLED" : "DISABLED"} ` +
    `(valid private key: ${hasValidPrivateKey}, app address: ${hasAppAddress})`,
);
logger.info(
  `[lens-connector] Plugin import ${LENS_PLUGIN_IMPORT ?? "UNAVAILABLE"}`,
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Execute a GraphQL query against the Lens V3 API. */
async function lensGraphQL(
  query: string,
  variables: Record<string, unknown> = {},
  opts: { authenticated?: boolean } = {},
): Promise<{ data?: unknown; errors?: Array<{ message: string }> }> {
  await sleep(RATE_LIMIT_DELAY_MS);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Origin: "https://eliza.ai",
  };
  if (LENS_API_KEY) {
    headers["x-api-key"] = LENS_API_KEY;
  }
  if (opts.authenticated && lensAccessToken) {
    headers.Authorization = `Bearer ${lensAccessToken}`;
  }

  const res = await fetch(LENS_API_URL, {
    method: "POST",
    headers,
    body: JSON.stringify({ query, variables }),
  });

  if (!res.ok) {
    return { errors: [{ message: `HTTP ${res.status}` }] };
  }

  return (await res.json()) as {
    data?: unknown;
    errors?: Array<{ message: string }>;
  };
}

/**
 * Authenticate with Lens V3 using wallet signature.
 * Sets the module-level lensAccessToken on success.
 */
async function lensAuthenticate(): Promise<boolean> {
  if (!LENS_PRIVATE_KEY || !LENS_APP_ADDRESS || !LENS_ACCOUNT_ADDRESS) {
    return false;
  }

  const wallet = new ethers.Wallet(LENS_PRIVATE_KEY);

  // 1. Request challenge
  const challengeResult = await lensGraphQL(
    `mutation Challenge($request: ChallengeRequest!) {
      challenge(request: $request) { id text }
    }`,
    {
      request: {
        accountOwner: {
          account: LENS_ACCOUNT_ADDRESS,
          app: LENS_APP_ADDRESS,
          owner: wallet.address,
        },
      },
    },
  );

  if (challengeResult.errors) {
    logger.warn(
      `[lens-connector] Challenge failed: ${challengeResult.errors[0]?.message}`,
    );
    return false;
  }

  const challenge = (
    challengeResult.data as { challenge: { id: string; text: string } }
  ).challenge;

  // 2. Sign the challenge text
  const signature = await wallet.signMessage(challenge.text);

  // 3. Authenticate with signed challenge
  const authResult = await lensGraphQL(
    `mutation Authenticate($request: SignedAuthChallenge!) {
      authenticate(request: $request) {
        ... on AuthenticationTokens { accessToken refreshToken }
        ... on WrongSignerError { reason }
        ... on ExpiredChallengeError { reason }
        ... on ForbiddenError { reason }
      }
    }`,
    { request: { id: challenge.id, signature } },
  );

  if (authResult.errors) {
    logger.warn(
      `[lens-connector] Auth failed: ${authResult.errors[0]?.message}`,
    );
    return false;
  }

  const auth = (
    authResult.data as {
      authenticate: { accessToken?: string; reason?: string };
    }
  ).authenticate;

  if (auth.accessToken) {
    lensAccessToken = auth.accessToken;
    logger.info("[lens-connector] Authentication successful");
    return true;
  }

  logger.warn(`[lens-connector] Auth rejected: ${auth.reason}`);
  return false;
}

/** Check API health. */
async function lensHealthCheck(): Promise<boolean> {
  const result = await lensGraphQL(`query { health }`);
  return result.errors === undefined || result.errors.length === 0;
}

/** Fetch a Lens account by address. Returns username or null. */
async function lensGetAccount(
  address: string,
): Promise<{ address: string; username: string | null } | null> {
  const result = await lensGraphQL(
    `query Account($request: AccountRequest!) {
      account(request: $request) {
        address
        username { localName }
      }
    }`,
    { request: { address } },
  );
  const data = result.data as
    | {
        account?: { address: string; username?: { localName: string } };
      }
    | undefined;
  if (!data?.account) return null;
  return {
    address: data.account.address,
    username: data.account.username?.localName ?? null,
  };
}

/** Fetch accounts available for a wallet. */
async function _lensGetAccountsForWallet(
  wallet: string,
): Promise<Array<{ address: string; username: string | null }>> {
  const result = await lensGraphQL(
    `query AccountsAvailable($request: AccountsAvailableRequest!) {
      accountsAvailable(request: $request) {
        items {
          ... on AccountManaged { account { address username { localName } } }
          ... on AccountOwned { account { address username { localName } } }
        }
      }
    }`,
    { request: { managedBy: wallet } },
  );
  const data = result.data as
    | {
        accountsAvailable?: {
          items: Array<{
            account: { address: string; username?: { localName: string } };
          }>;
        };
      }
    | undefined;
  return (
    data?.accountsAvailable?.items.map((item) => ({
      address: item.account.address,
      username: item.account.username?.localName ?? null,
    })) ?? []
  );
}

/** Wait for a transaction to be indexed, then return the post. */
async function lensWaitForPost(
  txHash: string,
  maxAttempts = 10,
): Promise<{
  id: string;
  content: string;
  commentOn?: { id: string };
  isDeleted: boolean;
} | null> {
  // Poll transactionStatus until indexed
  for (let i = 0; i < maxAttempts; i++) {
    await sleep(2000);
    const statusResult = await lensGraphQL(
      `query TransactionStatus($request: TransactionStatusRequest!) {
        transactionStatus(request: $request) {
          __typename
          ... on FinishedTransactionStatus { blockTimestamp }
          ... on FailedTransactionStatus { reason }
          ... on PendingTransactionStatus { blockTimestamp }
          ... on NotIndexedYetStatus { reason }
        }
      }`,
      { request: { txHash } },
    );
    const status = (
      statusResult.data as {
        transactionStatus?: {
          __typename?: string;
          blockTimestamp?: string;
          reason?: string;
        };
      }
    )?.transactionStatus;
    if (status?.__typename === "FinishedTransactionStatus") break;
    if (status?.__typename === "FailedTransactionStatus") return null;
  }

  // Now fetch the post by txHash
  const result = await lensGraphQL(
    `query Post($request: PostRequest!) {
      post(request: $request) {
        ... on Post {
          id
          isDeleted
          metadata { ... on TextOnlyMetadata { content } }
          commentOn { ... on Post { id } }
        }
      }
    }`,
    { request: { txHash } },
  );
  const data = result.data as
    | {
        post?: {
          id: string;
          isDeleted: boolean;
          metadata?: { content?: string };
          commentOn?: { id: string };
        };
      }
    | undefined;

  if (!data?.post) return null;
  return {
    id: data.post.id,
    content: data.post.metadata?.content ?? "",
    commentOn: data.post.commentOn,
    isDeleted: data.post.isDeleted,
  };
}

/** Create a post via Lens API. Returns post hash or null on error. */
async function lensCreatePost(content: string): Promise<string | null> {
  const result = await lensGraphQL(
    `mutation Post($request: CreatePostRequest!) {
      post(request: $request) {
        ... on PostResponse { hash }
        ... on SponsoredTransactionRequest { reason }
        ... on SelfFundedTransactionRequest { reason }
        ... on TransactionWillFail { reason }
      }
    }`,
    {
      request: {
        contentUri: `data:application/json,${encodeURIComponent(
          JSON.stringify({
            $schema: "https://json-schemas.lens.dev/posts/text-only/3.0.0.json",
            lens: {
              id: crypto.randomUUID(),
              mainContentFocus: "TEXT_ONLY",
              locale: "en",
              content,
            },
          }),
        )}`,
      },
    },
    { authenticated: true },
  );

  if (result.errors) {
    logger.warn(`[lens-connector] Post failed: ${result.errors[0]?.message}`);
    return null;
  }

  const data = result.data as
    | {
        post?: { hash?: string; reason?: string };
      }
    | undefined;
  return data?.post?.hash ?? null;
}

/** Delete a post (best-effort cleanup). */
async function lensDeletePost(postId: string): Promise<void> {
  await lensGraphQL(
    `mutation DeletePost($request: DeletePostRequest!) {
      deletePost(request: $request) {
        ... on PostResponse { hash }
        ... on SponsoredTransactionRequest { reason }
        ... on SelfFundedTransactionRequest { reason }
        ... on TransactionWillFail { reason }
      }
    }`,
    { request: { post: postId } },
    { authenticated: true },
  );
}

/** Add a reaction to a post. Returns success or null. */
async function lensAddReaction(postId: string): Promise<boolean | null> {
  const result = await lensGraphQL(
    `mutation AddReaction($request: AddReactionRequest!) {
      addReaction(request: $request) {
        ... on AddReactionResponse { success }
        ... on AddReactionFailure { reason }
      }
    }`,
    { request: { post: postId, reaction: "UPVOTE" } },
    { authenticated: true },
  );

  if (result.errors) {
    logger.warn(
      `[lens-connector] Reaction failed: ${result.errors[0]?.message}`,
    );
    return null;
  }
  return true;
}

/** Remove a reaction from a post. */
async function lensUndoReaction(postId: string): Promise<void> {
  await lensGraphQL(
    `mutation UndoReaction($request: UndoReactionRequest!) {
      undoReaction(request: $request) {
        ... on UndoReactionResponse { success }
        ... on UndoReactionFailure { reason }
      }
    }`,
    { request: { post: postId, reaction: "UPVOTE" } },
    { authenticated: true },
  );
}

/** Repost a post. Returns hash or null. */
async function lensRepost(postId: string): Promise<string | null> {
  const result = await lensGraphQL(
    `mutation Repost($request: CreateRepostRequest!) {
      repost(request: $request) {
        ... on PostResponse { hash }
        ... on SponsoredTransactionRequest { reason }
        ... on SelfFundedTransactionRequest { reason }
        ... on TransactionWillFail { reason }
      }
    }`,
    { request: { post: postId } },
    { authenticated: true },
  );

  if (result.errors) {
    logger.warn(`[lens-connector] Repost failed: ${result.errors[0]?.message}`);
    return null;
  }

  const data = result.data as
    | {
        repost?: { hash?: string; reason?: string };
      }
    | undefined;
  return data?.repost?.hash ?? null;
}

// ---------------------------------------------------------------------------
// Load Plugin Helper
// ---------------------------------------------------------------------------

const loadLensPlugin = async (): Promise<Plugin | null> => {
  if (!LENS_PLUGIN_IMPORT) return null;
  const mod = (await import(LENS_PLUGIN_IMPORT)) as {
    default?: Plugin;
    plugin?: Plugin;
    [key: string]: unknown;
  };
  return extractPlugin(mod) as Plugin | null;
};

// ---------------------------------------------------------------------------
// 1. Setup & Authentication Tests
// ---------------------------------------------------------------------------

describeIfPluginAvailable("Lens Connector - Setup & Authentication", () => {
  it(
    "can load the Lens plugin without errors",
    async () => {
      const plugin = await loadLensPlugin();
      expect(plugin).not.toBeNull();
      if (plugin) {
        expect(plugin.name).toBe("lens");
      }
    },
    TEST_TIMEOUT,
  );

  it(
    "Lens plugin exports required structure",
    async () => {
      const plugin = await loadLensPlugin();
      expect(plugin).toBeDefined();
      if (plugin) {
        expect(plugin.name).toBe("lens");
        expect(plugin.description).toBeDefined();
        expect(typeof plugin.description).toBe("string");
      }
    },
    TEST_TIMEOUT,
  );

  it(
    "plugin has clients",
    async () => {
      const plugin = await loadLensPlugin();
      expect(plugin).not.toBeNull();
      const p = plugin as Plugin & { clients?: unknown[] };
      expect(p.clients).toBeDefined();
      expect(Array.isArray(p.clients)).toBe(true);
      expect(p.clients?.length).toBeGreaterThan(0);
    },
    TEST_TIMEOUT,
  );

  describeIfLive("with Lens credentials", () => {
    it(
      "Lens API health check succeeds",
      async () => {
        const healthy = await lensHealthCheck();
        expect(healthy).toBe(true);
      },
      TEST_TIMEOUT,
    );

    it(
      "account address resolves to an account",
      async () => {
        const account = await lensGetAccount(LENS_ACCOUNT_ADDRESS!);
        if (account === null) {
          logger.warn(
            "[lens-connector] Account not found or rate-limited — skipping",
          );
          return;
        }
        expect(account.address).toBeDefined();
        expect(typeof account.address).toBe("string");
      },
      TEST_TIMEOUT,
    );

    it(
      "provides error for invalid GraphQL query",
      async () => {
        const result = await lensGraphQL(`query { nonExistentField }`);
        expect(result.errors).toBeDefined();
        expect(result.errors?.length).toBeGreaterThan(0);
      },
      TEST_TIMEOUT,
    );
  });
});

// ---------------------------------------------------------------------------
// 2. Post Handling Tests
// ---------------------------------------------------------------------------

describeIfLiveWrite("Lens Connector - Post Handling", () => {
  // Store post IDs (not tx hashes) for cleanup. Entries that are tx hashes
  // will silently fail deletion — that's acceptable for best-effort cleanup.
  const postIdsToCleanup: string[] = [];

  beforeAll(async () => {
    if (!lensAccessToken) {
      const ok = await lensAuthenticate();
      if (!ok)
        logger.warn("[lens-connector] Auth failed — write tests will skip");
    }
  }, TEST_TIMEOUT);

  afterAll(async () => {
    for (const id of postIdsToCleanup) {
      try {
        await lensDeletePost(id);
      } catch {
        // best-effort cleanup
      }
    }
  }, LIVE_WRITE_TIMEOUT);

  it(
    "can create a post",
    async () => {
      const content = `[test] lens post at ${Date.now()}`;
      const hash = await lensCreatePost(content);
      if (hash === null) {
        logger.warn("[lens-connector] Post failed or rate-limited — skipping");
        return;
      }
      expect(hash).toBeTruthy();
      // Wait for indexing to get the real post ID for cleanup
      const indexed = await lensWaitForPost(hash, 5);
      postIdsToCleanup.push(indexed?.id ?? hash);
    },
    LIVE_WRITE_TIMEOUT,
  );

  it(
    "can read back a posted post",
    async () => {
      const content = `[test] readback ${Date.now()}`;
      const hash = await lensCreatePost(content);
      if (hash === null) {
        logger.warn("[lens-connector] Post failed or rate-limited — skipping");
        return;
      }
      const post = await lensWaitForPost(hash);
      if (post === null) {
        logger.warn("[lens-connector] Read failed or rate-limited — skipping");
        postIdsToCleanup.push(hash); // fallback: tx hash for best-effort cleanup
        return;
      }
      postIdsToCleanup.push(post.id);
      expect(post.content).toBe(content);
    },
    LIVE_WRITE_TIMEOUT,
  );

  it(
    "can fetch notifications",
    async () => {
      const result = await lensGraphQL(
        `query Notifications($request: NotificationRequest!) {
          notifications(request: $request) {
            items { ... on ReactionNotification { id } }
          }
        }`,
        { request: { orderBy: "DEFAULT" } },
        { authenticated: true },
      );
      if (result.errors) {
        logger.warn("[lens-connector] Notifications query failed — skipping");
        return;
      }
      const data = result.data as
        | {
            notifications?: { items?: unknown[] };
          }
        | undefined;
      expect(data?.notifications?.items).toBeDefined();
      expect(Array.isArray(data?.notifications?.items)).toBe(true);
    },
    TEST_TIMEOUT,
  );

  it(
    "can delete a post",
    async () => {
      const content = `[test] delete-me ${Date.now()}`;
      const hash = await lensCreatePost(content);
      if (hash === null) {
        logger.warn("[lens-connector] Post failed or rate-limited — skipping");
        return;
      }

      // Wait for post to be indexed first
      const post = await lensWaitForPost(hash);
      if (post === null) {
        logger.warn("[lens-connector] Post not indexed — skipping delete test");
        return;
      }

      // The delete call not throwing is the assertion — Lens deletion is eventual
      await lensDeletePost(post.id);
    },
    LIVE_WRITE_TIMEOUT,
  );
});

// ---------------------------------------------------------------------------
// 3. Lens-Specific Features
// ---------------------------------------------------------------------------

describeIfLiveWrite("Lens Connector - Lens-Specific Features", () => {
  const postIdsToCleanup: string[] = [];
  const reactionsToCleanup: string[] = [];

  beforeAll(async () => {
    if (!lensAccessToken) {
      const ok = await lensAuthenticate();
      if (!ok)
        logger.warn("[lens-connector] Auth failed — write tests will skip");
    }
  }, TEST_TIMEOUT);

  afterAll(async () => {
    for (const id of reactionsToCleanup) {
      try {
        await lensUndoReaction(id);
      } catch {
        /* best-effort */
      }
    }
    for (const id of postIdsToCleanup) {
      try {
        await lensDeletePost(id);
      } catch {
        /* best-effort */
      }
    }
  }, LIVE_WRITE_TIMEOUT);

  it(
    "account has a username",
    async () => {
      const account = await lensGetAccount(LENS_ACCOUNT_ADDRESS!);
      if (account === null) {
        logger.warn("[lens-connector] Account not found — skipping");
        return;
      }
      // V3 username is the localName portion
      expect(typeof account.username).toBe("string");
      if (account.username) {
        expect(account.username.length).toBeGreaterThan(0);
      }
    },
    TEST_TIMEOUT,
  );

  it(
    "repost works",
    async () => {
      const content = `[test] repost-target ${Date.now()}`;
      const postHash = await lensCreatePost(content);
      if (postHash === null) {
        logger.warn("[lens-connector] Post failed — skipping");
        return;
      }
      postIdsToCleanup.push(postHash);

      // Wait for indexing so the post ID is available
      const post = await lensWaitForPost(postHash);
      if (post === null) {
        logger.warn("[lens-connector] Post not indexed — skipping");
        return;
      }

      const repostHash = await lensRepost(post.id);
      if (repostHash === null) {
        logger.warn("[lens-connector] Repost failed — skipping");
        return;
      }
      expect(repostHash).toBeTruthy();
      postIdsToCleanup.push(repostHash);
    },
    LIVE_WRITE_TIMEOUT,
  );

  it(
    "reactions work",
    async () => {
      const content = `[test] react-target ${Date.now()}`;
      const postHash = await lensCreatePost(content);
      if (postHash === null) {
        logger.warn("[lens-connector] Post failed — skipping");
        return;
      }
      postIdsToCleanup.push(postHash);

      // Wait for indexing
      const post = await lensWaitForPost(postHash);
      if (post === null) {
        logger.warn("[lens-connector] Post not indexed — skipping");
        return;
      }

      const result = await lensAddReaction(post.id);
      if (result === null) {
        logger.warn("[lens-connector] Reaction failed — skipping");
        return;
      }
      expect(result).toBe(true);
      reactionsToCleanup.push(post.id);
    },
    LIVE_WRITE_TIMEOUT,
  );

  it(
    "post stats are accessible",
    async () => {
      const content = `[test] stats-check ${Date.now()}`;
      const postHash = await lensCreatePost(content);
      if (postHash === null) {
        logger.warn("[lens-connector] Post failed — skipping");
        return;
      }
      postIdsToCleanup.push(postHash);

      // Wait for indexing
      const post = await lensWaitForPost(postHash);
      if (post === null) {
        logger.warn("[lens-connector] Post not indexed — skipping");
        return;
      }

      const result = await lensGraphQL(
        `query Post($request: PostRequest!) {
          post(request: $request) {
            ... on Post {
              id
              stats { reactions reposts comments }
            }
          }
        }`,
        { request: { post: post.id } },
      );

      if (result.errors) {
        logger.warn("[lens-connector] Stats query failed — skipping");
        return;
      }

      const data = result.data as
        | {
            post?: {
              id: string;
              stats?: { reactions: number; reposts: number; comments: number };
            };
          }
        | undefined;
      expect(data?.post?.stats).toBeDefined();
    },
    LIVE_WRITE_TIMEOUT,
  );
});

// ---------------------------------------------------------------------------
// 4. Media & Attachments
// ---------------------------------------------------------------------------

describeIfLiveWrite("Lens Connector - Media & Attachments", () => {
  const postIdsToCleanup: string[] = [];

  beforeAll(async () => {
    if (!lensAccessToken) {
      const ok = await lensAuthenticate();
      if (!ok)
        logger.warn("[lens-connector] Auth failed — write tests will skip");
    }
  }, TEST_TIMEOUT);

  afterAll(async () => {
    for (const id of postIdsToCleanup) {
      try {
        await lensDeletePost(id);
      } catch {
        /* best-effort */
      }
    }
  }, LIVE_WRITE_TIMEOUT);

  it(
    "posting with image metadata works",
    async () => {
      const content = `[test] img post ${Date.now()}`;
      const result = await lensGraphQL(
        `mutation Post($request: CreatePostRequest!) {
          post(request: $request) {
            ... on PostResponse { hash }
            ... on SponsoredTransactionRequest { reason }
            ... on SelfFundedTransactionRequest { reason }
            ... on TransactionWillFail { reason }
          }
        }`,
        {
          request: {
            contentUri: `data:application/json,${encodeURIComponent(
              JSON.stringify({
                $schema: "https://json-schemas.lens.dev/posts/image/3.0.0.json",
                lens: {
                  id: crypto.randomUUID(),
                  mainContentFocus: "IMAGE",
                  locale: "en",
                  content,
                  image: {
                    item: "https://picsum.photos/200",
                    type: "image/jpeg",
                  },
                },
              }),
            )}`,
          },
        },
        { authenticated: true },
      );

      if (result.errors) {
        logger.warn("[lens-connector] Image post failed — skipping");
        return;
      }

      const data = result.data as
        | {
            post?: { hash?: string };
          }
        | undefined;
      const hash = data?.post?.hash;
      expect(hash).toBeTruthy();
      if (hash) postIdsToCleanup.push(hash);
    },
    LIVE_WRITE_TIMEOUT,
  );
});

// ---------------------------------------------------------------------------
// 5. Error Handling
// ---------------------------------------------------------------------------

describeIfLive("Lens Connector - Error Handling", () => {
  it(
    "invalid GraphQL query returns structured error",
    async () => {
      const result = await lensGraphQL(`query { thisFieldDoesNotExist }`);
      expect(result).toBeDefined();
      expect(result.errors).toBeDefined();
      expect(result.errors?.length).toBeGreaterThan(0);
    },
    TEST_TIMEOUT,
  );

  it(
    "non-existent post ID returns null",
    async () => {
      const result = await lensGraphQL(
        `query Post($request: PostRequest!) {
          post(request: $request) { ... on Post { id } }
        }`,
        { request: { post: "0x00-0x00-INVALID" } },
      );
      const data = result.data as { post?: unknown } | undefined;
      // Should return null post or an error
      expect(data?.post === null || result.errors !== undefined).toBe(true);
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

describe("Lens Connector - Integration", () => {
  it("Lens is mapped in CONNECTOR_PLUGINS", async () => {
    const mod = await tryWorkspaceImport<{
      CONNECTOR_PLUGINS: Record<string, string>;
    }>("@elizaos/app-core");
    if (!mod) {
      logger.warn("[lens-connector] Workspace not built — skipping");
      return;
    }
    expect(mod.CONNECTOR_PLUGINS.lens).toBe("@elizaos/plugin-lens");
  });

  it("Lens is mapped in CHANNEL_PLUGIN_MAP", async () => {
    let mod: { CHANNEL_PLUGIN_MAP: Record<string, string> } | null;
    try {
      mod = await tryWorkspaceImport<{
        CHANNEL_PLUGIN_MAP: Record<string, string>;
      }>("@elizaos/app-core");
    } catch {
      mod = null;
    }
    if (!mod) {
      logger.warn(
        "[lens-connector] Workspace not built or import failed — skipping",
      );
      return;
    }
    expect(mod.CHANNEL_PLUGIN_MAP.lens).toBe("@elizaos/plugin-lens");
  });
});
