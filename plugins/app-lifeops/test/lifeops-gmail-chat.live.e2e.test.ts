import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createElizaPlugin, resolveOAuthDir } from "@elizaos/agent";
import type { AgentRuntime } from "@elizaos/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { describeIf } from "../../../test/helpers/conditional-tests.ts";
import {
  createConversation,
  postConversationMessage,
  req,
} from "../../../test/helpers/http";
import {
  isLiveTestEnabled,
  selectLiveProvider,
} from "../../../test/helpers/live-provider";
import { saveEnv } from "../../../test/helpers/test-utils";
import { stochasticTest } from "../../../packages/app-core/test/helpers/stochastic-test";
import {
  createLifeOpsConnectorGrant,
  createLifeOpsGmailSyncState,
  LifeOpsRepository,
} from "../src/lifeops/repository.js";
import { createLifeOpsTestRuntime } from "./helpers/runtime.js";

const GOOGLE_CLIENT_ID = "lifeops-gmail-live-chat-client";
const LIVE_PROVIDER = selectLiveProvider("openai") ?? selectLiveProvider();
const LIVE_GMAIL_CHAT_ENABLED = isLiveTestEnabled() && Boolean(LIVE_PROVIDER);

function buildGmailMessage(args: {
  agentId: string;
  grantId: string;
  accountEmail: string;
  id: string;
  externalId: string;
  threadId: string;
  subject: string;
  from: string;
  fromEmail: string;
  snippet: string;
  receivedAt: string;
  isUnread?: boolean;
  isImportant?: boolean;
  likelyReplyNeeded?: boolean;
  triageScore?: number;
}) {
  return {
    id: args.id,
    externalId: args.externalId,
    threadId: args.threadId,
    agentId: args.agentId,
    grantId: args.grantId,
    accountEmail: args.accountEmail,
    provider: "google" as const,
    side: "owner" as const,
    subject: args.subject,
    from: args.from,
    fromEmail: args.fromEmail,
    replyTo: args.fromEmail,
    to: ["shawmakesmagic@gmail.com"],
    cc: [],
    snippet: args.snippet,
    receivedAt: args.receivedAt,
    isUnread: args.isUnread ?? false,
    isImportant: args.isImportant ?? false,
    likelyReplyNeeded: args.likelyReplyNeeded ?? false,
    triageScore: args.triageScore ?? 50,
    triageReason: args.likelyReplyNeeded ? "reply needed" : "search hit",
    labels: args.isUnread ? ["INBOX", "UNREAD"] : ["INBOX"],
    htmlLink: `https://mail.google.com/mail/u/${encodeURIComponent(args.accountEmail)}/#all/${args.threadId}`,
    metadata: {
      messageIdHeader: `<${args.externalId}@example.com>`,
      referencesHeader: `<${args.threadId}@example.com>`,
    },
    syncedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

async function seedLocalGmail(runtime: AgentRuntime, stateDir: string) {
  const repository = new LifeOpsRepository(runtime);
  const agentId = String(runtime.agentId);
  const nowIso = new Date().toISOString();
  const tokenRef = `${agentId}/owner/local.json`;
  const grantId = "gmail-live-google-grant";
  const tokenPath = path.join(
    resolveOAuthDir(process.env, stateDir),
    "lifeops",
    "google",
    tokenRef,
  );
  await fs.mkdir(path.dirname(tokenPath), { recursive: true, mode: 0o700 });
  await fs.writeFile(
    tokenPath,
    JSON.stringify(
      {
        provider: "google",
        agentId,
        side: "owner",
        mode: "local",
        clientId: GOOGLE_CLIENT_ID,
        redirectUri: "http://127.0.0.1/callback",
        accessToken: "gmail-live-chat-access-token",
        refreshToken: "gmail-live-chat-refresh-token",
        tokenType: "Bearer",
        grantedScopes: [
          "openid",
          "email",
          "profile",
          "https://www.googleapis.com/auth/gmail.metadata",
          "https://www.googleapis.com/auth/gmail.send",
        ],
        expiresAt: Date.now() + 60 * 60 * 1000,
        refreshTokenExpiresAt: null,
        createdAt: nowIso,
        updatedAt: nowIso,
      },
      null,
      2,
    ),
    {
      encoding: "utf-8",
      mode: 0o600,
    },
  );

  await repository.upsertConnectorGrant({
    ...createLifeOpsConnectorGrant({
      agentId,
      provider: "google",
      side: "owner",
      identity: {
        email: "shawmakesmagic@gmail.com",
        name: "Shaw",
      },
      grantedScopes: [
        "openid",
        "email",
        "profile",
        "https://www.googleapis.com/auth/gmail.metadata",
        "https://www.googleapis.com/auth/gmail.send",
      ],
      capabilities: [
        "google.basic_identity",
        "google.gmail.triage",
        "google.gmail.send",
      ],
      tokenRef,
      mode: "local",
      metadata: {},
      lastRefreshAt: nowIso,
    }),
    id: grantId,
  });

  await repository.upsertGmailSyncState(
    createLifeOpsGmailSyncState({
      agentId,
      provider: "google",
      side: "owner",
      mailbox: "me",
      grantId,
      maxResults: 50,
      syncedAt: nowIso,
    }),
  );

  const messages = [
    buildGmailMessage({
      agentId,
      grantId,
      accountEmail: "shawmakesmagic@gmail.com",
      id: "gmail-live-pat-recent",
      externalId: "gmail-live-pat-recent-ext",
      threadId: "gmail-live-pat-thread-recent",
      subject: "Pat follow-up",
      from: "Pat Smith",
      fromEmail: "pat@example.com",
      snippet:
        "Wanted to follow up on the last few weeks and see if next week works.",
      receivedAt: "2026-04-09T16:00:00.000Z",
      isUnread: true,
      likelyReplyNeeded: true,
      triageScore: 92,
    }),
    buildGmailMessage({
      agentId,
      grantId,
      accountEmail: "shawmakesmagic@gmail.com",
      id: "gmail-live-venue",
      externalId: "gmail-live-venue-ext",
      threadId: "gmail-live-venue-thread",
      subject: "Venue confirmation",
      from: "Morgan",
      fromEmail: "morgan@example.com",
      snippet: "Can you confirm the venue for tomorrow?",
      receivedAt: "2026-04-09T15:00:00.000Z",
      isUnread: true,
      isImportant: true,
      likelyReplyNeeded: true,
      triageScore: 95,
    }),
  ];

  for (const message of messages) {
    await repository.upsertGmailMessage(message, "owner");
  }
}

type StartedLiveServer = {
  close: () => Promise<void>;
  port: number;
};

async function startLiveServer(): Promise<StartedLiveServer> {
  const stateDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "lifeops-gmail-live-chat-"),
  );
  const envBackup = saveEnv(
    ...Object.keys(LIVE_PROVIDER?.env ?? {}),
    "ELIZA_STATE_DIR",
    "ELIZA_GOOGLE_OAUTH_DESKTOP_CLIENT_ID",
    "PGLITE_DATA_DIR",
  );

  for (const [key, value] of Object.entries(LIVE_PROVIDER?.env ?? {})) {
    process.env[key] = value;
  }
  process.env.ELIZA_STATE_DIR = stateDir;
  process.env.ELIZA_GOOGLE_OAUTH_DESKTOP_CLIENT_ID = GOOGLE_CLIENT_ID;

  const runtimeResult = await createLifeOpsTestRuntime({
    withLLM: true,
    preferredProvider: LIVE_PROVIDER?.name,
    plugins: [createElizaPlugin({ agentId: "main" })],
  });
  await seedLocalGmail(runtimeResult.runtime, stateDir);

  const { startApiServer } = await import("@elizaos/agent");
  const server = await startApiServer({
    port: 0,
    runtime: runtimeResult.runtime,
    skipDeferredStartupWork: true,
  });
  await req(server.port, "POST", "/api/agent/start");

  return {
    port: server.port,
    close: async () => {
      await server.close();
      await runtimeResult.cleanup();
      await fs.rm(stateDir, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100,
      });
      envBackup.restore();
    },
  };
}

async function sendChat(
  port: number,
  conversationId: string,
  text: string,
  options?: {
    allowProviderIssue?: boolean;
  },
): Promise<string> {
  const { status, data } = await postConversationMessage(
    port,
    conversationId,
    { text },
    undefined,
    { timeoutMs: 120_000 },
  );
  expect(status).toBe(200);
  const responseText = String(data.text ?? data.response ?? "");
  expect(responseText.length).toBeGreaterThan(0);
  if (!options?.allowProviderIssue) {
    expect(responseText.toLowerCase()).not.toContain("provider issue");
  }
  return responseText;
}

async function runReplyNeededFlow(
  port: number,
  title: string,
): Promise<string> {
  const { conversationId } = await createConversation(port, { title });
  return await sendChat(
    port,
    conversationId,
    "Which emails need a reply about venue details?",
  );
}

async function runDraftFlow(
  port: number,
  title: string,
  options?: {
    allowProviderIssue?: boolean;
  },
): Promise<string> {
  const { conversationId } = await createConversation(port, { title });
  const searchResponse = await sendChat(
    port,
    conversationId,
    "Search my email and tell me if anyone named Pat emailed me.",
  );
  expect(searchResponse).toMatch(/pat/i);

  return await sendChat(
    port,
    conversationId,
    "Draft a reply to Pat thanking him and saying next week works. Do not send it yet.",
    options,
  );
}

describeIf(LIVE_GMAIL_CHAT_ENABLED)("life-ops gmail live chat flows", () => {
  let server: StartedLiveServer | null = null;

  beforeAll(async () => {
    server = await startLiveServer();
  }, 180_000);

  afterAll(async () => {
    await server?.close();
  });

  stochasticTest(
    "searches Gmail narratively with the real agent runtime",
    async () => {
      const { conversationId } = await createConversation(server?.port ?? 0, {
        title: "gmail search",
      });
      const responseText = await sendChat(
        server?.port ?? 0,
        conversationId,
        "Search my email and tell me if anyone named Pat emailed me.",
      );

      expect(responseText).toMatch(/pat/i);
    },
    { perRunTimeoutMs: 180_000, label: "gmail-chat/narrative-search" },
  );

  describe("strict single-attempt", () => {
    stochasticTest(
      "finds reply-needed Gmail items with the real agent runtime on the first attempt",
      async () => {
        const responseText = await runReplyNeededFlow(
          server?.port ?? 0,
          "gmail venue strict",
        );

        expect(responseText).toMatch(/venue|morgan/i);
      },
      { perRunTimeoutMs: 180_000, label: "gmail-chat/reply-needed-strict" },
    );

    stochasticTest(
      "drafts a Gmail reply from prior conversation context on the first attempt",
      async () => {
        const responseText = await runDraftFlow(
          server?.port ?? 0,
          "gmail draft strict",
        );

        expect(responseText).toMatch(/next week|thank/i);
      },
      { perRunTimeoutMs: 180_000, label: "gmail-chat/draft-strict" },
    );
  });

  describe("recovery coverage", () => {
    it("recovers reply-needed Gmail lookup within three attempts when the first answer is weak", async () => {
      let lastResponse = "";

      for (let attempt = 1; attempt <= 3; attempt += 1) {
        lastResponse = await runReplyNeededFlow(
          server?.port ?? 0,
          `gmail venue recovery ${attempt}`,
        );

        if (/venue|morgan/i.test(lastResponse)) {
          return;
        }

        if (attempt < 3) {
          await new Promise((resolve) => setTimeout(resolve, 1500));
        }
      }

      throw new Error(
        `Reply-needed Gmail flow did not stabilize: ${lastResponse}`,
      );
    }, 180_000);

    it("recovers Gmail draft creation within three attempts when the first answer is weak", async () => {
      let lastResponse = "";

      for (let attempt = 1; attempt <= 3; attempt += 1) {
        lastResponse = await runDraftFlow(
          server?.port ?? 0,
          `gmail draft recovery ${attempt}`,
          { allowProviderIssue: true },
        );

        if (
          !lastResponse.toLowerCase().includes("provider issue") &&
          /next week|thank/i.test(lastResponse)
        ) {
          return;
        }

        if (attempt < 3) {
          await new Promise((resolve) => setTimeout(resolve, 1500));
        }
      }

      throw new Error(`Gmail draft flow did not stabilize: ${lastResponse}`);
    }, 180_000);
  });
});
