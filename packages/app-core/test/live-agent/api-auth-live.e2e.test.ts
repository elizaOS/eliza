/**
 * Live E2E tests for API auth + LLM + wallet integration.
 *
 * These tests exercise the real authenticated flow end-to-end:
 * auth -> onboarding -> agent start -> chat -> wallet operations -> agent stop.
 */

import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { config as loadDotenv } from "dotenv";
import { createElizaPlugin } from "@elizaos/agent/runtime/eliza-plugin";
import { describeIf } from "../helpers/conditional-tests.ts";
import {
  buildIsolatedLiveProviderEnv,
  isLiveTestEnabled,
  LIVE_PROVIDER_ENV_KEYS,
  selectLiveProvider,
} from "../helpers/live-provider";
import { createRealTestRuntime } from "../helpers/real-runtime";
import { saveEnv } from "../helpers/test-utils";
import {
  createConversation,
  postConversationMessage,
  req,
} from "../helpers/http";

const envPath = path.resolve(import.meta.dirname, "..", "..", "..", ".env");
loadDotenv({ path: envPath });

const LIVE_PROVIDER = selectLiveProvider("openai") ?? selectLiveProvider();
const CAN_RUN = isLiveTestEnabled() && Boolean(LIVE_PROVIDER);

type StartedLiveServer = {
  close: () => Promise<void>;
  port: number;
};

type WalletExportResponse = {
  evm: {
    address: string | null;
    privateKey: string;
  } | null;
  solana: {
    address: string | null;
    privateKey: string;
  } | null;
};

function readExportNonce(errorMessage: unknown): {
  delaySeconds: number;
  nonce: string;
} {
  if (typeof errorMessage !== "string" || errorMessage.length === 0) {
    throw new Error(
      "Wallet export nonce request did not return an error payload",
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(errorMessage);
  } catch (error) {
    throw new Error(
      `Wallet export nonce response was not valid JSON: ${errorMessage}`,
      { cause: error },
    );
  }

  if (
    !parsed ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    typeof parsed.nonce !== "string" ||
    typeof parsed.delaySeconds !== "number"
  ) {
    throw new Error(
      `Wallet export nonce response was malformed: ${errorMessage}`,
    );
  }

  return {
    nonce: parsed.nonce,
    delaySeconds: parsed.delaySeconds,
  };
}

async function exportWallet(
  port: number,
  exportToken: string,
  headers: Record<string, string>,
): Promise<WalletExportResponse> {
  const { status: nonceStatus, data: nonceData } = await req(
    port,
    "POST",
    "/api/wallet/export",
    { confirm: true, exportToken, requestNonce: true },
    headers,
  );
  expect(nonceStatus).toBe(403);

  const { delaySeconds, nonce } = readExportNonce(nonceData.error);
  await sleep((delaySeconds + 1) * 1_000);

  const { status: exportStatus, data: exportData } = await req(
    port,
    "POST",
    "/api/wallet/export",
    { confirm: true, exportToken, exportNonce: nonce },
    headers,
  );
  expect(exportStatus).toBe(200);

  return exportData as WalletExportResponse;
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

    const text = String(result.data?.text ?? result.data?.response ?? "").trim();
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
    await import("@elizaos/agent/api/wallet");

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

  await ensureWalletKeys();

  const runtimeResult = await createRealTestRuntime({
    withLLM: true,
    preferredProvider: LIVE_PROVIDER?.name,
    plugins: [createElizaPlugin({ agentId: "main" })],
  });
  const { startApiServer } = await import("../../src/api/server");
  const { _resetForTesting } = await import(
    "@elizaos/app-steward/routes/wallet-export-guard"
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

    it("step 1: auth status reports required + pairing enabled", async () => {
      const { status, data } = await req(
        server?.port ?? 0,
        "GET",
        "/api/auth/status",
      );
      expect(status).toBe(200);
      expect(data.required).toBe(true);
      expect(data.pairingEnabled).toBe(true);
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

    it("step 9: wallet generate + export round-trip with auth", async () => {
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

      const exported = await exportWallet(
        server?.port ?? 0,
        EXPORT_TOKEN,
        authHeaders,
      );
      const evm = exported.evm;
      expect(evm).not.toBeNull();
      expect(evm.address?.toLowerCase()).toBe(wallets[0].address.toLowerCase());
      expect(evm.privateKey.startsWith("0x")).toBe(true);
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

  it("wallet import + export through auth works with real keys", async () => {
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

    const exported = await exportWallet(server?.port ?? 0, EXPORT_TOKEN, auth);
    const evm = exported.evm;
    expect(evm).not.toBeNull();
    expect(evm.privateKey).toBe(importedKey);
    expect(evm.address).toBe(importData.address);
  });
});
