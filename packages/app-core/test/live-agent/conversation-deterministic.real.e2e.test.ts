/** Exercises pairing, authenticated chat persistence, and local wallet mutations through real HTTP, runtime, and storage with isolated fixture keys and one strict model reply. */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { deriveEvmAddress, generateWalletKeys } from "@elizaos/agent";
import {
  getAgentHostBridge,
  setAgentHostBridge,
} from "@elizaos/agent/runtime/host-bridge";
import {
  createDeterministicModelPlugin,
  strictTerminalReplyFixture,
} from "@elizaos/testing";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  _resetAuthPairingStateForTests,
  ensureAuthPairingCodeForRemoteAccess,
} from "../../src/api/auth-pairing-routes.ts";
import { startApiServer } from "../../src/api/server.ts";
import { installAgentHostBridge } from "../../src/runtime/install-agent-host-bridge.ts";
import {
  createConversation,
  postConversationMessage,
  req,
} from "../helpers/http.ts";
import { useIsolatedConfigEnv } from "../helpers/isolated-config.ts";
import { createRealTestRuntime } from "../helpers/real-runtime.ts";

interface ConversationMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  timestamp: number;
}

const userText = "Hello from the deterministic live test.";
const replyText = "Hello from the deterministic model provider.";
const model = createDeterministicModelPlugin({
  fixtures: [strictTerminalReplyFixture({ input: userText, text: replyText })],
});

describe("conversation deterministic real coverage", () => {
  let server: Awaited<ReturnType<typeof startApiServer>>;
  let runtime: Awaited<ReturnType<typeof createRealTestRuntime>>;
  let configEnv: ReturnType<typeof useIsolatedConfigEnv>;
  const previousBridge = getAgentHostBridge();
  const initialKeys = generateWalletKeys();

  beforeAll(async () => {
    configEnv = useIsolatedConfigEnv("auth-chat-wallet-");
    const env = {
      ELIZA_STATE_DIR: path.dirname(configEnv.configPath),
      ELIZA_PERSIST_CONFIG_PATH: configEnv.configPath,
      ELIZA_API_TOKEN: "auth-chat-wallet-fixture-token",
      ELIZA_REQUIRE_LOCAL_AUTH: "1",
      EVM_PRIVATE_KEY: initialKeys.evmPrivateKey,
      SOLANA_PRIVATE_KEY: initialKeys.solanaPrivateKey,
      ELIZA_WALLET_OS_STORE: "0",
      WALLET_SOURCE_EVM: "local",
      WALLET_SOURCE_SOLANA: "local",
      ELIZA_PAIRING_DISABLED: undefined,
      ELIZA_CLOUD_PROVISIONED: undefined,
      ELIZAOS_CLOUD_ENABLED: undefined,
      ELIZAOS_CLOUD_API_KEY: undefined,
      STEWARD_AGENT_TOKEN: undefined,
      STEWARD_API_URL: undefined,
      STEWARD_AGENT_ID: undefined,
      ELIZA_STEWARD_AGENT_ID: undefined,
    };
    for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
    _resetAuthPairingStateForTests();
    runtime = await createRealTestRuntime({ plugins: [model] });
    installAgentHostBridge();
    server = await startApiServer({
      port: 0,
      runtime: runtime.runtime,
      skipDeferredStartupWork: true,
    });
  }, 120_000);

  afterAll(async () => {
    try {
      try {
        await server?.close();
      } finally {
        await runtime?.cleanup();
      }
    } finally {
      try {
        await configEnv?.restore();
      } finally {
        _resetAuthPairingStateForTests();
        setAgentHostBridge(previousBridge);
        vi.unstubAllEnvs();
      }
    }
  });

  function port(): number {
    return server.port;
  }

  it("pairs an owner, persists authenticated chat and wallet changes, then stops the agent", async () => {
    const pairing = ensureAuthPairingCodeForRemoteAccess();
    if (!pairing) throw new Error("Fixture pairing unavailable");
    const paired = await req(port(), "POST", "/api/auth/pair", {
      code: pairing.code,
      instanceId: pairing.instanceId,
    });
    expect(paired.status).toBe(200);
    const auth = { Authorization: `Bearer ${paired.data.token}` };
    const firstRun = await req(
      port(),
      "POST",
      "/api/first-run",
      {
        name: "FixtureAgent",
        bio: ["Fixture agent"],
        systemPrompt: "Respond to the test.",
      },
      auth,
    );
    expect(firstRun.status).toBe(200);
    expect(firstRun.data.ok).toBe(true);
    expect(
      (await req(port(), "POST", "/api/agent/start", undefined, auth)).status,
    ).toBe(200);
    const created = await createConversation(
      port(),
      {
        title: "Deterministic chat",
      },
      auth,
    );
    expect(created.status).toBe(200);
    const conversationId = created.conversationId;
    expect(typeof conversationId).toBe("string");
    expect(conversationId.length).toBeGreaterThan(0);

    const denied = await postConversationMessage(port(), conversationId, {
      text: userText,
    });
    expect(denied.status).toBe(401);
    const sent = await postConversationMessage(
      port(),
      conversationId,
      { text: userText },
      auth,
      { timeoutMs: 90_000 },
    );
    expect(sent.status).toBe(200);
    expect(sent.data.text).toBe(replyText);
    expect(typeof sent.data.agentName).toBe("string");

    const history = await req(
      port(),
      "GET",
      `/api/conversations/${encodeURIComponent(conversationId)}/messages`,
      undefined,
      auth,
    );
    expect(history.status).toBe(200);
    const messages = history.data.messages as ConversationMessage[];
    expect(Array.isArray(messages)).toBe(true);
    expect(messages.length).toBeGreaterThanOrEqual(2);

    const userMessages = messages.filter((m) => m.role === "user");
    const assistantMessages = messages.filter((m) => m.role === "assistant");
    expect(userMessages.length).toBeGreaterThanOrEqual(1);
    expect(assistantMessages.length).toBeGreaterThanOrEqual(1);

    expect(userMessages.some((m) => m.text === userText)).toBe(true);
    for (const assistant of assistantMessages) {
      expect(assistant.text).toBe(replyText);
    }

    expect(messages[0].role).toBe("user");
    const firstUserIndex = messages.findIndex((m) => m.role === "user");
    const firstAssistantIndex = messages.findIndex(
      (m) => m.role === "assistant",
    );
    expect(firstUserIndex).toBeGreaterThanOrEqual(0);
    expect(firstAssistantIndex).toBeGreaterThan(firstUserIndex);
    for (let i = 1; i < messages.length; i += 1) {
      expect(messages[i].timestamp).toBeGreaterThanOrEqual(
        messages[i - 1].timestamp,
      );
    }
    expect((await req(port(), "GET", "/api/wallet/addresses")).status).toBe(
      401,
    );
    const initial = await req(
      port(),
      "GET",
      "/api/wallet/addresses",
      undefined,
      auth,
    );
    expect(initial.status).toBe(200);
    expect(initial.data.evmAddress).toBe(
      deriveEvmAddress(initialKeys.evmPrivateKey),
    );
    for (const header of ["X-Eliza-Token", "X-Api-Key"]) {
      expect(
        (
          await req(port(), "GET", "/api/status", undefined, {
            [header]: String(paired.data.token),
          })
        ).status,
      ).toBe(200);
    }
    const generated = await req(
      port(),
      "POST",
      "/api/wallet/generate",
      { chain: "evm", source: "local" },
      auth,
    );
    expect(generated.status).toBe(200);
    expect(generated.data.ok).toBe(true);
    expect(generated.data.warnings).toBeUndefined();
    const wallets = generated.data.wallets as Array<{
      chain: string;
      address: string;
    }>;
    expect(wallets).toHaveLength(1);
    expect(wallets[0].chain).toBe("evm");
    expect(wallets[0].address).not.toBe(initial.data.evmAddress);
    const generatedReadback = await req(
      port(),
      "GET",
      "/api/wallet/addresses",
      undefined,
      auth,
    );
    expect(generatedReadback.status).toBe(200);
    expect(generatedReadback.data.evmAddress).toBe(wallets[0].address);

    const privateKey = generateWalletKeys().evmPrivateKey;
    const imported = await req(
      port(),
      "POST",
      "/api/wallet/import",
      { chain: "evm", privateKey },
      auth,
    );
    expect(imported.status).toBe(200);
    expect(imported.data.ok).toBe(true);
    expect(imported.data.warnings).toBeUndefined();
    const importedReadback = await req(
      port(),
      "GET",
      "/api/wallet/addresses",
      undefined,
      { ...auth, Origin: `http://localhost:${port()}` },
    );
    expect(importedReadback.status).toBe(200);
    expect(importedReadback.data.evmAddress).toBe(deriveEvmAddress(privateKey));
    const persisted = JSON.parse(await readFile(configEnv.configPath, "utf8"));
    expect(deriveEvmAddress(persisted.env.EVM_PRIVATE_KEY)).toBe(
      deriveEvmAddress(privateKey),
    );
    expect(persisted.wallet.primary.evm).toBe("local");
    const exported = await req(
      port(),
      "POST",
      "/api/wallet/export",
      { confirm: true, exportToken: "invalid-fixture-token" },
      auth,
    );
    expect(exported.status).toBe(410);
    expect(
      (
        await req(port(), "GET", "/api/wallet/addresses", undefined, {
          ...auth,
          Origin: "https://attacker.example.com",
        })
      ).status,
    ).toBe(403);
    expect(
      (await req(port(), "POST", "/api/agent/stop", undefined, auth)).status,
    ).toBe(200);
    expect(
      (await req(port(), "GET", "/api/status", undefined, auth)).data.state,
    ).toBe("stopped");
    model.assertFixturesConsumed();
  }, 120_000);
});
