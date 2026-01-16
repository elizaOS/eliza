import type { IAgentRuntime } from "@elizaos/core";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SolanaService } from "../../service";

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
      templates: {},
      messageExamples: [],
      postExamples: [],
      topics: ["testing"],
      adjectives: ["helpful"],
      knowledge: [],
      plugins: [],
      secrets,
      settings: {},
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

  it.skip("should work: no wallet initially, then add via setSetting", async () => {
    const testKeypair = Keypair.generate();
    const testPublicKey = testKeypair.publicKey;
    const testPrivateKey = bs58.encode(testKeypair.secretKey);

    const originalSubscribe = SolanaService.prototype.subscribeToAccount;
    const originalUpdate = SolanaService.prototype.updateWalletData;

    SolanaService.prototype.subscribeToAccount = vi.fn(async () => {});
    SolanaService.prototype.updateWalletData = vi.fn(async () => {
      return { totalUsd: "0", items: [] };
    });

    const service = new SolanaService(runtime);

    const initialPublicKey = await service.getPublicKey();
    expect(initialPublicKey).toBeNull();

    if (runtime.character.settings) {
      runtime.character.settings.secrets = {
        WALLET_PRIVATE_KEY: testPrivateKey,
        WALLET_PUBLIC_KEY: testPublicKey.toBase58(),
      };
    }

    (runtime.getSetting as ReturnType<typeof vi.fn>).mockImplementation((key: string) => {
      if (key === "WALLET_PRIVATE_KEY") return testPrivateKey;
      if (key === "WALLET_PUBLIC_KEY") return testPublicKey.toBase58();
      return undefined;
    });

    await (service as unknown as { reloadKeys(): Promise<void> }).reloadKeys();

    const newPublicKey = await service.getPublicKey();

    expect(newPublicKey).not.toBeNull();
    expect(newPublicKey?.toBase58()).toBe(testPublicKey.toBase58());

    const keypair = await service.getWalletKeypair();
    expect(keypair).not.toBeNull();
    expect(keypair.publicKey.toBase58()).toBe(testPublicKey.toBase58());

    SolanaService.prototype.subscribeToAccount = originalSubscribe;
    SolanaService.prototype.updateWalletData = originalUpdate;
  });
});
