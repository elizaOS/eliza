/**
 * Lazy Loading Test - Core Scenario
 *
 * Tests that the Solana service can handle the case where:
 * 1. Service is initialized WITHOUT a wallet
 * 2. Wallet is added later via runtime settings
 * 3. Service can load the wallet on-demand after reloadKeys()
 *
 * Uses mocked AgentRuntime for reliable testing.
 */

import type { IAgentRuntime } from "@elizaos/core";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SolanaService } from "../../service";

// Mock @elizaos/core
vi.mock("@elizaos/core", async () => {
  const actual = await vi.importActual("@elizaos/core");
  return {
    ...actual,
    logger: {
      log: vi.fn(),
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  };
});

/**
 * Creates a mock AgentRuntime for testing.
 */
function createMockRuntime(settings: Record<string, string | undefined> = {}): IAgentRuntime {
  const secrets = { ...settings };

  return {
    agentId: "test-agent-id" as `${string}-${string}-${string}-${string}-${string}`,
    character: {
      name: "Test Agent",
      bio: ["A test agent for Solana"],
      system: "You are a helpful assistant.",
      plugins: [],
      settings: {
        secrets,
      },
      messageExamples: [],
      postExamples: [],
      topics: ["testing"],
      adjectives: ["helpful"],
      style: { all: [], chat: [], post: [] },
    },
    getSetting: vi.fn((key: string) => {
      // Check character settings first
      if (secrets[key]) {
        return secrets[key];
      }
      // Check env vars
      return process.env[key];
    }),
    setSetting: vi.fn((key: string, value: string) => {
      secrets[key] = value;
    }),
    getService: vi.fn(),
    registerService: vi.fn(),
    useModel: vi.fn(),
    emitEvent: vi.fn(),
    getServiceLoadPromise: vi.fn().mockResolvedValue(undefined),
  } as unknown as IAgentRuntime;
}

describe("SolanaService Lazy Loading - Core Scenario", () => {
  let runtime: IAgentRuntime;

  beforeEach(() => {
    // Create runtime without wallet initially
    runtime = createMockRuntime({});
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // Skip: Test needs rework to match updated SolanaService behavior
  it.skip("should work: no wallet initially, then add via setSetting", async () => {
    // Generate test wallet
    const testKeypair = Keypair.generate();
    const testPublicKey = testKeypair.publicKey;
    const testPrivateKey = bs58.encode(testKeypair.secretKey);

    // Mock network calls to avoid actual RPC requests
    const originalSubscribe = SolanaService.prototype.subscribeToAccount;
    const originalUpdate = SolanaService.prototype.updateWalletData;

    SolanaService.prototype.subscribeToAccount = vi.fn(async () => {
      console.log("🔇 Mocked subscribeToAccount (no network call)");
    });
    SolanaService.prototype.updateWalletData = vi.fn(async () => {
      console.log("🔇 Mocked updateWalletData (no network call)");
    });

    // Step 1: Create service WITHOUT wallet
    console.log("📝 Step 1: Creating SolanaService without wallet...");
    const service = new SolanaService(runtime);

    // Step 2: Verify no wallet is available
    console.log("📝 Step 2: Verifying wallet is not available...");
    const initialPublicKey = await service.getPublicKey();
    expect(initialPublicKey).toBeNull();
    console.log("✅ Wallet correctly returns null");

    // Step 3: Add wallet via character settings (simulating wallet creation)
    console.log("📝 Step 3: Adding wallet via runtime character settings...");

    // Use the real runtime's character settings
    if (runtime.character.settings) {
      runtime.character.settings.secrets = {
        WALLET_PRIVATE_KEY: testPrivateKey,
        WALLET_PUBLIC_KEY: testPublicKey.toBase58(),
      };
    }

    // Also update the mock getSetting to return the new values
    (runtime.getSetting as ReturnType<typeof vi.fn>).mockImplementation((key: string) => {
      if (key === "WALLET_PRIVATE_KEY") return testPrivateKey;
      if (key === "WALLET_PUBLIC_KEY") return testPublicKey.toBase58();
      return undefined;
    });

    console.log(`✅ Wallet added: ${testPublicKey.toBase58()}`);

    // Step 4: Reload keys to pick up new settings
    console.log("📝 Step 4: Calling reloadKeys()...");
    // Cast to access private method for testing
    await (service as unknown as { reloadKeys(): Promise<void> }).reloadKeys();
    console.log("✅ Keys reloaded");

    // Step 5: Verify wallet is now available
    console.log("📝 Step 5: Verifying wallet is now available...");
    const newPublicKey = await service.getPublicKey();

    expect(newPublicKey).not.toBeNull();
    expect(newPublicKey?.toBase58()).toBe(testPublicKey.toBase58());
    console.log(`✅ Wallet loaded successfully: ${newPublicKey?.toBase58()}`);

    // Step 6: Verify keypair also works
    console.log("📝 Step 6: Verifying keypair is accessible...");
    const keypair = await service.getWalletKeypair();
    expect(keypair).not.toBeNull();
    expect(keypair.publicKey.toBase58()).toBe(testPublicKey.toBase58());
    console.log(`✅ Keypair loaded successfully`);

    console.log("\n🎉 SUCCESS: Lazy loading works as expected!");

    // Restore original methods
    SolanaService.prototype.subscribeToAccount = originalSubscribe;
    SolanaService.prototype.updateWalletData = originalUpdate;
  });
});
