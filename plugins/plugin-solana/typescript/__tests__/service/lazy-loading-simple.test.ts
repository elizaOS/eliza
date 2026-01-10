/**
 * Lazy Loading Test - Core Scenario
 *
 * Tests that the Solana service can handle the case where:
 * 1. Service is initialized WITHOUT a wallet
 * 2. Wallet is added later via runtime.setSetting()
 * 3. Service can load the wallet on-demand after reloadKeys()
 */

import { describe, expect, it, mock } from "bun:test";
import type { IAgentRuntime } from "@elizaos/core";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { SolanaService } from "../../service";

describe("SolanaService Lazy Loading - Core Scenario", () => {
  it("should work: no wallet initially, then add via setSetting", async () => {
    // Generate test wallet
    const testKeypair = Keypair.generate();
    const testPublicKey = testKeypair.publicKey;
    const testPrivateKey = bs58.encode(testKeypair.secretKey);

    // Mock network calls to avoid actual RPC requests
    const originalSubscribe = SolanaService.prototype.subscribeToAccount;
    const originalUpdate = SolanaService.prototype.updateWalletData;

    SolanaService.prototype.subscribeToAccount = mock(async () => {
      console.log("🔇 Mocked subscribeToAccount (no network call)");
    });
    SolanaService.prototype.updateWalletData = mock(async () => {
      console.log("🔇 Mocked updateWalletData (no network call)");
    });

    // Create mock runtime WITHOUT wallet
    const mockRuntime: IAgentRuntime = {
      agentId: "test-agent",
      serverUrl: "http://localhost:3000",
      databaseAdapter: {} as any,
      token: "test-token",
      character: {
        name: "Test Agent",
        settings: {
          secrets: {}, // NO WALLET HERE!
          voice: { model: "en_US-male-medium" },
        },
      } as any,
      providers: [],
      actions: [],
      evaluators: [],
      plugins: [],
      messageManager: {} as any,
      descriptionManager: {} as any,
      documentsManager: {} as any,
      knowledgeManager: {} as any,
      loreManager: {} as any,
      cacheManager: {} as any,
      services: new Map(),
      getSetting: mock((key: string) => {
        // Support both SOLANA_* and WALLET_* prefixes
        const character = mockRuntime.character;
        const characterSettings = character && character.settings;
        const characterSettingsSecrets = characterSettings && characterSettings.secrets;
        if (key === "WALLET_PRIVATE_KEY" || key === "SOLANA_PRIVATE_KEY") {
          return characterSettingsSecrets && characterSettingsSecrets[key];
        }
        if (key === "WALLET_PUBLIC_KEY" || key === "SOLANA_PUBLIC_KEY") {
          return characterSettingsSecrets && characterSettingsSecrets[key];
        }
        return undefined;
      }),
      setSetting: mock((key: string, value: string) => {
        const character = mockRuntime.character;
        const characterSettings = character && character.settings;
        if (!characterSettings || !characterSettings.secrets) {
          mockRuntime.character.settings!.secrets = {};
        }
        const characterSettingsSecrets = mockRuntime.character.settings && mockRuntime.character.settings.secrets;
        if (characterSettingsSecrets) {
          characterSettingsSecrets[key] = value;
        }
      }),
      getServiceLoadPromise: mock(() => Promise.resolve(undefined)),
      getService: mock(() => null),
      getCache: mock(() => null),
      setCache: mock(() => {}),
      logger: {
        debug: mock(() => {}),
        info: mock(() => {}),
        log: mock(() => {}),
        warn: mock(() => {}),
        error: mock(() => {}),
        success: mock(() => {}),
      },
    } as any;

    // Step 1: Create service WITHOUT wallet
    console.log("📝 Step 1: Creating SolanaService without wallet...");
    const service = new SolanaService(mockRuntime);

    // Step 2: Verify no wallet is available
    console.log("📝 Step 2: Verifying wallet is not available...");
    const initialPublicKey = await service.getPublicKey();
    expect(initialPublicKey).toBeNull();
    console.log("✅ Wallet correctly returns null");

    // Step 3: Add wallet via setSetting (simulating wallet creation)
    console.log("📝 Step 3: Adding wallet via runtime.setSetting...");
    mockRuntime.character.settings!.secrets = {
      WALLET_PRIVATE_KEY: testPrivateKey, // Note: must use WALLET_PRIVATE_KEY or SOLANA_PRIVATE_KEY
      WALLET_PUBLIC_KEY: testPublicKey.toBase58(),
    };
    console.log(`✅ Wallet added: ${testPublicKey.toBase58()}`);

    // Step 4: Reload keys to pick up new settings
    console.log("📝 Step 4: Calling reloadKeys()...");
    await (service as any).reloadKeys();
    console.log("✅ Keys reloaded");

    // Step 5: Verify wallet is now available
    console.log("📝 Step 5: Verifying wallet is now available...");
    const newPublicKey = await service.getPublicKey();

    expect(newPublicKey).not.toBeNull();
    expect(newPublicKey!.toBase58()).toBe(testPublicKey.toBase58());
    console.log(`✅ Wallet loaded successfully: ${newPublicKey!.toBase58()}`);

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
