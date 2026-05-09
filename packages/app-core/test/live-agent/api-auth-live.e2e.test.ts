/**
 * Live E2E tests for API auth + LLM + wallet integration.
 *
 * These tests exercise the real authenticated flow end-to-end:
 * auth -> onboarding -> agent start -> chat -> wallet operations -> agent stop.
 */

import path from "node:path";
import crypto from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { createElizaPlugin } from "@elizaos/agent";
import { config as loadDotenv } from "dotenv";
import { afterAll, beforeAll, expect, it } from "vitest";
import { describeIf } from "../helpers/conditional-tests.ts";
import {
  createConversation,
  postConversationMessage,
  req,
} from "../helpers/http";
import {
  buildIsolatedLiveProviderEnv,
  isLiveTestEnabled,
  LIVE_PROVIDER_ENV_KEYS,
  selectLiveProvider,
} from "../helpers/live-provider.ts";
import { createRealTestRuntime } from "../helpers/real-runtime.ts";
import { saveEnv } from "../helpers/test-utils";

const envPath = path.resolve(import.meta.dirname, "..", "..", "..", ".env");
loadDotenv({ path: envPath });

const LIVE_PROVIDER =
  selectLiveProvider("cerebras") ??
  selectLiveProvider("openai") ??
  selectLiveProvider();
const CAN_RUN = isLiveTestEnabled() && Boolean(LIVE_PROVIDER);

type StartedLiveServer = {
  close: () => Promise<void>;
  port: number;
};

async function seedMachineSession(
  runtimeResult: Awaited<ReturnType<typeof createRealTestRuntime>>,
  sessionId: string,
): Promise<void> {
  const db = (runtimeResult.runtime.adapter as { db?: unknown } | undefined)
    ?.db;
  if (!db) {
    throw new Error("Auth session seed requires a runtime database");
  }

  const { AuthStore } = await import("../../src/services/auth-store");
  const store = new AuthStore(
    db as ConstructorParameters<typeof AuthStore>[0],
  );
  const now = Date.now();
  const identity = await store.createIdentity({
    id: crypto.randomUUID(),
    kind: "machine",
    displayName: "Live Auth E2E",
    createdAt: now,
    passwordHash: null,
    cloudUserId: null,
  });
  await store.createSession({
    id: sessionId,
    identityId: identity.id,
    kind: "machine",
    createdAt: now,
    lastSeenAt: now,
    expiresAt: now + 60 * 60 * 1000,
    rememberDevice: false,
    csrfSecret: crypto.randomBytes(32).toString("hex"),
    ip: null,
    userAgent: "api-auth-live-e2e",
    scopes: ["*"],
  });
}

async function assertWalletExportRejected(
  port: number,
  headers: Record<string, string>,
): Promise<void> {
  const { status, data } = await req(
    port,
    "POST",
    "/api/wallet/export",
    { confirm: true, exportToken: "test-token" },
    headers,
  );
  expect(status).toBe(401);
  expect(String((data as { error?: string }).error ?? "")).toContain(
    "Invalid export token",
  );
}

async function postConversationMessageWithRetry(
  port: number,
  conversationId: string,
  body: { text: string },
  headers: Record<string, string>,
  options?: { timeoutMs?: number },
): Promise<{ status: number; data: Record<string, unknown> }> {
  const deadline = Date.now() + (options?.timeoutMs ?? 20_000);
  let lastResult: { status: number; data: Record<string, unknown> } | null =
    null;

  do {
    const result = (await postConversationMessage(
      port,
      conversationId,
      body,
      headers,
      options,
    )) as {
      status: number;
      data: Record<string, unknown>;
    };
    lastResult = result;

    const text = String(
      result.data?.text ?? result.data?.response ?? "",
    ).trim();
    if (
      result.status === 200 &&
      text.length > 0 &&
      !isProviderIssueResponse(text)
    ) {
      return result;
    }

    if (Date.now() >= deadline) {
      break;
    }
    await sleep(1_000);
  } while (Date.now() < deadline);

  if (!lastResult) {
    throw new Error("Authenticated chat did not return a response payload");
  }

  return lastResult;
}

function isProviderIssueResponse(text: string): boolean {
  return /provider issue/i.test(text);
}

async function ensureWalletKeys(): Promise<void> {
  if (!process.env.SOLANA_PRIVATE_KEY && process.env.SOLANA_API_KEY) {
    process.env.SOLANA_PRIVATE_KEY = process.env.SOLANA_API_KEY;
  }
  if (
    process.env.EVM_PRIVATE_KEY &&
    !process.env.EVM_PRIVATE_KEY.startsWith("0x")
  ) {
    process.env.EVM_PRIVATE_KEY = `0x${process.env.EVM_PRIVATE_KEY}`;
  }

  const { deriveEvmAddress, deriveSolanaAddress, generateWalletKeys } =
    await import("@elizaos/agent");

  let generatedKeys: {
    evmPrivateKey: string;
    solanaPrivateKey: string;
  } | null = null;

  try {
    if (process.env.EVM_PRIVATE_KEY?.trim()) {
      deriveEvmAddress(process.env.EVM_PRIVATE_KEY);
    } else {
      throw new Error("missing EVM key");
    }
  } catch {
    generatedKeys ??= generateWalletKeys();
    process.env.EVM_PRIVATE_KEY = generatedKeys.evmPrivateKey;
  }

  try {
    if (process.env.SOLANA_PRIVATE_KEY?.trim()) {
      deriveSolanaAddress(process.env.SOLANA_PRIVATE_KEY);
    } else {
      throw new Error("missing Solana key");
    }
  } catch {
    generatedKeys ??= generateWalletKeys();
    process.env.SOLANA_PRIVATE_KEY = generatedKeys.solanaPrivateKey;
  }
}

async function startLiveServer(args: {
  apiToken: string;
  exportToken?: string;
}): Promise<{ restore: () => Promise<void>; server: StartedLiveServer }> {
  const envBackup = saveEnv(
    ...LIVE_PROVIDER_ENV_KEYS,
    "ELIZA_API_TOKEN",
    "ELIZA_WALLET_EXPORT_TOKEN",
    "ELIZA_PAIRING_DISABLED",
    "ELIZA_API_BIND",
    "ELIZA_CLOUD_PROVISIONED",
    "EVM_PRIVATE_KEY",
    "SOLANA_PRIVATE_KEY",
    "SOLANA_API_KEY",
    "PGLITE_DATA_DIR",
  );

  const isolatedProviderEnv = buildIsolatedLiveProviderEnv(
    process.env,
    LIVE_PROVIDER,
  );
  for (const key of LIVE_PROVIDER_ENV_KEYS) {
    process.env[key] = isolatedProviderEnv[key] ?? "";
  }
  process.env.ELIZA_API_TOKEN = args.apiToken;
  if (args.exportToken) {
    process.env.ELIZA_WALLET_EXPORT_TOKEN = args.exportToken;
  } else {
    delete process.env.ELIZA_WALLET_EXPORT_TOKEN;
  }
  delete process.env.ELIZA_PAIRING_DISABLED;
  process.env.ELIZA_CLOUD_PROVISIONED = "1";

  await ensureWalletKeys();

  const runtimeResult = await createRealTestRuntime({
    withLLM: true,
    preferredProvider: LIVE_PROVIDER?.name,
    plugins: [createElizaPlugin({ agentId: "main" })],
  });
  await seedMachineSession(runtimeResult, args.apiToken);
  const { startApiServer } = await import("../../src/api/server");
  const { _resetForTesting } = await import(
    "@elizaos/plugin-wallet"
  );
  _resetForTesting();
  const server = await startApiServer({
    port: 0,
    runtime: runtimeResult.runtime,
    skipDeferredStartupWork: true,
  });

  return {
    server,
    restore: async () => {
      await server.close();
      await runtimeResult.cleanup();
      envBackup.restore();
    },
  };
}

describeIf(CAN_RUN)(
  "Live: Authenticated full flow (LLM + wallet + auth)",
  () => {
    const API_TOKEN = `live-e2e-test-token-${Date.now()}`;
    const EXPORT_TOKEN = `live-wallet-export-token-${Date.now()}`;
    let server: StartedLiveServer | null = null;
    let restore: (() => Promise<void>) | null = null;

    const authHeaders = { Authorization: `Bearer ${API_TOKEN}` };

    beforeAll(async () => {
      const started = await startLiveServer({
        apiToken: API_TOKEN,
        exportToken: EXPORT_TOKEN,
      });
      server = started.server;
      restore = started.restore;
    }, 120_000);

    afterAll(async () => {
      await restore?.();
    });

    it("step 1: auth status reports required + cloud pairing disabled", async () => {
      const { status, data } = await req(
        server?.port ?? 0,
        "GET",
        "/api/auth/status",
      );
      expect(status).toBe(200);
      expect(data.required).toBe(true);
      expect(data.pairingEnabled).toBe(false);
    });

    it("step 2: unauthenticated requests are blocked", async () => {
      const { status } = await req(server?.port ?? 0, "GET", "/api/status");
      expect(status).toBe(401);
    });

    it("step 3: authenticated status works", async () => {
      const { status, data } = await req(
        server?.port ?? 0,
        "GET",
        "/api/status",
        undefined,
        authHeaders,
      );
      expect(status).toBe(200);
      expect(typeof data.agentName).toBe("string");
    });

    it("step 4: wallet addresses via auth", async () => {
      const { status, data } = await req(
        server?.port ?? 0,
        "GET",
        "/api/wallet/addresses",
        undefined,
        authHeaders,
      );
      expect(status).toBe(200);
      expect(data.evmAddress).toBeTruthy();
      const addr = data.evmAddress as string;
      expect(addr.startsWith("0x")).toBe(true);
      expect(addr.length).toBe(42);
    });

    it("step 5: wallet config via auth", async () => {
      const { status, data } = await req(
        server?.port ?? 0,
        "GET",
        "/api/wallet/config",
        undefined,
        authHeaders,
      );
      expect(status).toBe(200);
      expect(Array.isArray(data.evmChains)).toBe(true);
      expect(typeof data.evmBalanceReady).toBe("boolean");
      expect(typeof data.walletSource).toBe("string");
    });

    it("step 6: onboarding with auth", async () => {
      const { status, data } = await req(
        server?.port ?? 0,
        "POST",
        "/api/onboarding",
        {
          name: "LiveAuthAgent",
          bio: ["A live E2E test agent with auth"],
          systemPrompt: "You are a helpful assistant. Keep responses brief.",
        },
        authHeaders,
      );
      expect(status).toBe(200);
      expect(data.ok).toBe(true);
    });

    it("step 7: agent start with auth", async () => {
      const { status, data } = await req(
        server?.port ?? 0,
        "POST",
        "/api/agent/start",
        undefined,
        authHeaders,
      );
      expect(status).toBe(200);
      expect(data.ok ?? data.state).toBeTruthy();

      const { data: statusData } = await req(
        server?.port ?? 0,
        "GET",
        "/api/status",
        undefined,
        authHeaders,
      );
      expect(statusData.state).toBe("paused");
    });

    it("step 8: chat with auth uses the real runtime", async () => {
      const { conversationId } = await createConversation(
        server?.port ?? 0,
        { title: "Auth chat" },
        authHeaders,
      );

      const { status: noAuth } = await postConversationMessage(
        server?.port ?? 0,
        conversationId,
        { text: "hello" },
      );
      expect(noAuth).toBe(401);

      const { status, data } = await postConversationMessageWithRetry(
        server?.port ?? 0,
        conversationId,
        { text: "Say auth-ok and nothing else." },
        authHeaders,
        { timeoutMs: 120_000 },
      );
      expect(status).toBe(200);
      const text = String(data.text ?? data.response ?? "");
      expect(text.length).toBeGreaterThan(0);
      expect(text.toLowerCase()).toContain("auth");
    }, 120_000);

    it("step 9: wallet generate + invalid export token rejected with auth", async () => {
      const { status: genStatus, data: genData } = await req(
        server?.port ?? 0,
        "POST",
        "/api/wallet/generate",
        { chain: "evm" },
        authHeaders,
      );
      expect(genStatus).toBe(200);
      expect(genData.ok).toBe(true);

      const wallets = genData.wallets as Array<{
        address: string;
        chain: string;
      }>;
      expect(wallets).toHaveLength(1);
      expect(wallets[0].chain).toBe("evm");

      const { data: addrs } = await req(
        server?.port ?? 0,
        "GET",
        "/api/wallet/addresses",
        undefined,
        authHeaders,
      );
      expect((addrs.evmAddress as string).toLowerCase()).toBe(
        wallets[0].address.toLowerCase(),
      );

      await assertWalletExportRejected(server?.port ?? 0, authHeaders);
    });

    it("step 10: agent stop with auth", async () => {
      const { status, data } = await req(
        server?.port ?? 0,
        "POST",
        "/api/agent/stop",
        undefined,
        authHeaders,
      );
      expect(status).toBe(200);
      expect(data.ok).toBe(true);

      const { data: statusData } = await req(
        server?.port ?? 0,
        "GET",
        "/api/status",
        undefined,
        authHeaders,
      );
      expect(statusData.state).toBe("stopped");
    });
  },
);

describeIf(CAN_RUN)("Live: Token header variants with LLM", () => {
  const API_TOKEN = `header-variant-token-${Date.now()}`;
  let server: StartedLiveServer | null = null;
  let restore: (() => Promise<void>) | null = null;

  beforeAll(async () => {
    const started = await startLiveServer({ apiToken: API_TOKEN });
    server = started.server;
    restore = started.restore;
  }, 120_000);

  afterAll(async () => {
    await restore?.();
  });

  it("Bearer token works for chat", async () => {
    await req(server?.port ?? 0, "POST", "/api/agent/start", undefined, {
      Authorization: `Bearer ${API_TOKEN}`,
    });

    const { conversationId } = await createConversation(
      server?.port ?? 0,
      { title: "Header variants" },
      { Authorization: `Bearer ${API_TOKEN}` },
    );

    const { status: noAuth } = await postConversationMessage(
      server?.port ?? 0,
      conversationId,
      { text: "hello" },
    );
    expect(noAuth).toBe(401);

    const { status, data } = await postConversationMessageWithRetry(
      server?.port ?? 0,
      conversationId,
      { text: "Say hello" },
      { Authorization: `Bearer ${API_TOKEN}` },
      { timeoutMs: 120_000 },
    );
    expect(status).toBe(200);
    expect(String(data.text ?? data.response ?? "")).toBeTruthy();

    await req(server?.port ?? 0, "POST", "/api/agent/stop", undefined, {
      Authorization: `Bearer ${API_TOKEN}`,
    });
  }, 120_000);

  it("X-Eliza-Token works for status", async () => {
    const { status } = await req(
      server?.port ?? 0,
      "GET",
      "/api/status",
      undefined,
      {
        "X-Eliza-Token": API_TOKEN,
      },
    );
    expect(status).toBe(200);
  });

  it("X-Api-Key works for status", async () => {
    const { status } = await req(
      server?.port ?? 0,
      "GET",
      "/api/status",
      undefined,
      {
        "X-Api-Key": API_TOKEN,
      },
    );
    expect(status).toBe(200);
  });
});

describeIf(CAN_RUN)("Live: Auth + CORS + wallet combined", () => {
  const API_TOKEN = `combined-test-token-${Date.now()}`;
  const EXPORT_TOKEN = `combined-wallet-export-token-${Date.now()}`;
  let server: StartedLiveServer | null = null;
  let restore: (() => Promise<void>) | null = null;

  beforeAll(async () => {
    const started = await startLiveServer({
      apiToken: API_TOKEN,
      exportToken: EXPORT_TOKEN,
    });
    server = started.server;
    restore = started.restore;
  }, 120_000);

  afterAll(async () => {
    await restore?.();
  });

  it("localhost origin + auth = wallet operations work", async () => {
    const headers = {
      Authorization: `Bearer ${API_TOKEN}`,
      Origin: `http://localhost:${server?.port ?? 0}`,
    };

    const { status, data } = await req(
      server?.port ?? 0,
      "GET",
      "/api/wallet/addresses",
      undefined,
      headers,
    );
    expect(status).toBe(200);
    expect(data.evmAddress).toBeTruthy();
  });

  it("external origin blocked even with valid auth", async () => {
    const { status } = await req(
      server?.port ?? 0,
      "GET",
      "/api/wallet/addresses",
      undefined,
      {
        Authorization: `Bearer ${API_TOKEN}`,
        Origin: "https://attacker.example.com",
      },
    );
    expect(status).toBe(403);
  });

  it("wallet import works; invalid export token is rejected", async () => {
    const auth = { Authorization: `Bearer ${API_TOKEN}` };
    const importedKey = process.env.EVM_PRIVATE_KEY;

    const { status: importStatus, data: importData } = await req(
      server?.port ?? 0,
      "POST",
      "/api/wallet/import",
      {
        chain: "evm",
        privateKey: importedKey,
      },
      auth,
    );
    expect(importStatus).toBe(200);
    expect(importData.ok).toBe(true);

    await assertWalletExportRejected(server?.port ?? 0, auth);
  });
});
