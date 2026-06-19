/**
 * Anvil E2E tests for ERC-8004 registry and ERC-8041 collection contracts.
 *
 * Tests the complete lifecycle:
 * - Local Anvil node startup
 * - Contract deployment
 * - Wallet funding
 * - Agent registration (ERC-8004)
 * - Drop minting (ERC-8041)
 * - Mint-out scenarios
 * - NFT queries for inventory display
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DropService, RegistryService, TxService } from "@elizaos/agent";
import { ethers } from "ethers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { describeIf } from "../../../test/helpers/conditional-tests.ts";
import { type AnvilInstance, startAnvil } from "./anvil-helper";
import { type DeployedContracts, deployContracts } from "./contract-deployer";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_CORE_CONTRACTS_OUT_DIR = path.resolve(
  __dirname,
  "..",
  "..",
  "..",
  "packages",
  "app-core",
  "test",
  "contracts",
  "out",
);

function hasAnvilBinary(): boolean {
  try {
    const result = spawnSync("anvil", ["--version"], { stdio: "ignore" });
    return result.status === 0;
  } catch {
    return false;
  }
}

function hasContractArtifacts(): boolean {
  const artifactVariants = [
    [
      path.join(
        APP_CORE_CONTRACTS_OUT_DIR,
        "MockElizaAgentRegistry.sol",
        "MockElizaAgentRegistry.json",
      ),
      path.join(
        APP_CORE_CONTRACTS_OUT_DIR,
        "MockAgentRegistry.sol",
        "MockAgentRegistry.json",
      ),
    ],
    [
      path.join(
        APP_CORE_CONTRACTS_OUT_DIR,
        "MockElizaCollection.sol",
        "MockElizaCollection.json",
      ),
      path.join(
        APP_CORE_CONTRACTS_OUT_DIR,
        "MockCollection.sol",
        "MockCollection.json",
      ),
    ],
  ];

  return artifactVariants.every((candidates) =>
    candidates.some((filePath) => fs.existsSync(filePath)),
  );
}

const describeAnvil = describeIf(
  process.env.ELIZA_LIVE_BROWSER_SUITE === "1" &&
    hasAnvilBinary() &&
    hasContractArtifacts(),
);

// ---------------------------------------------------------------------------
// Test Suite
// ---------------------------------------------------------------------------

describeAnvil("Anvil Contract E2E Tests", () => {
  let anvil: AnvilInstance;
  let contracts: DeployedContracts;
  let txService: TxService;
  let registryService: RegistryService;
  let dropService: DropService;

  // Test wallet (Anvil account #1, not #0 which is the deployer)
  const TEST_PRIVATE_KEY =
    "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
  const TEST_ADDRESS = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";

  beforeAll(async () => {
    // 1. Start Anvil
    anvil = await startAnvil();
    expect(anvil.rpcUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

    // 2. Deploy contracts using the funded deployer wallet
    contracts = await deployContracts(anvil.fundedWallet);
    expect(contracts.registry.address).toMatch(/^0x[a-fA-F0-9]{40}$/);
    expect(contracts.collection.address).toMatch(/^0x[a-fA-F0-9]{40}$/);

    // 3. Create services using test wallet
    txService = new TxService(anvil.rpcUrl, TEST_PRIVATE_KEY);
    registryService = new RegistryService(
      txService,
      contracts.registry.address,
    );
    dropService = new DropService(
      txService,
      contracts.collection.address,
      true, // dropEnabled
    );

    // 4. Fund the test wallet
    await anvil.fund(TEST_ADDRESS, "10");
  }, 60_000);

  afterAll(async () => {
    if (anvil) await anvil.stop();
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Anvil Node Tests
  // ═══════════════════════════════════════════════════════════════════════════

  describe("Anvil Node", () => {
    it("responds to RPC calls", async () => {
      const chainId = await txService.getChainId();
      expect(chainId).toBe(31337);
    });

    it("test wallet has funded balance", async () => {
      const balance = await txService.getBalanceFormatted();
      expect(parseFloat(balance)).toBeGreaterThan(9);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // ERC-8004 Registry Tests
  // ═══════════════════════════════════════════════════════════════════════════

  describe("ERC-8004 Agent Registry", () => {
    it("starts with no registered agents", async () => {
      const status = await registryService.getStatus();
      expect(status.registered).toBe(false);
      expect(status.totalAgents).toBe(0);
    });

    it("registers an agent and mints identity NFT", async () => {
      const result = await registryService.register({
        name: "TestElizaAgent",
        endpoint: "http://localhost:3000/agent",
        capabilitiesHash: ethers.id("test-capabilities"),
        tokenURI: "ipfs://QmTestTokenURI",
      });

      expect(result.tokenId).toBeGreaterThan(0);
      expect(result.txHash).toMatch(/^0x[a-fA-F0-9]{64}$/);
    });

    it("shows registered status after registration", async () => {
      const status = await registryService.getStatus();
      expect(status.registered).toBe(true);
      expect(status.tokenId).toBeGreaterThan(0);
      expect(status.agentName).toBe("TestElizaAgent");
      expect(status.agentEndpoint).toBe("http://localhost:3000/agent");
      expect(status.isActive).toBe(true);
      expect(status.tokenURI).toBe("ipfs://QmTestTokenURI");
      expect(status.totalAgents).toBe(1);
    });

    it("can update token URI", async () => {
      const newURI = "ipfs://QmUpdatedTokenURI";

      await registryService.updateTokenURI(newURI);

      const status = await registryService.getStatus();
      expect(status.tokenURI).toBe(newURI);
    });

    it("can update agent endpoint", async () => {
      const newEndpoint = "http://localhost:4000/agent";
      await registryService.updateAgent(
        newEndpoint,
        ethers.id("updated-capabilities"),
      );

      const status = await registryService.getStatus();
      expect(status.agentEndpoint).toBe(newEndpoint);
    });

    it("can sync full profile", async () => {
      await registryService.syncProfile({
        name: "SyncedElizaAgent",
        endpoint: "http://localhost:5000/agent",
        capabilitiesHash: ethers.id("synced-capabilities"),
        tokenURI: "ipfs://QmSyncedTokenURI",
      });

      const status = await registryService.getStatus();
      expect(status.agentName).toBe("SyncedElizaAgent");
      expect(status.agentEndpoint).toBe("http://localhost:5000/agent");
      expect(status.tokenURI).toBe("ipfs://QmSyncedTokenURI");
    });

    it("prevents duplicate registration", async () => {
      await expect(
        registryService.register({
          name: "DuplicateAgent",
          endpoint: "http://localhost:6000/agent",
          capabilitiesHash: ethers.id("duplicate"),
          tokenURI: "ipfs://QmDuplicate",
        }),
      ).rejects.toThrow();
    });

    it("NFT ownership is queryable for inventory", async () => {
      // Query the ERC-721 directly
      const registryContract = new ethers.Contract(
        contracts.registry.address,
        [
          "function balanceOf(address) view returns (uint256)",
          "function ownerOf(uint256) view returns (address)",
          "function tokenURI(uint256) view returns (string)",
        ],
        anvil.provider,
      );

      const balance = await registryContract.balanceOf(TEST_ADDRESS);
      expect(Number(balance)).toBe(1);

      const status = await registryService.getStatus();
      const owner = await registryContract.ownerOf(status.tokenId);
      expect(owner.toLowerCase()).toBe(TEST_ADDRESS.toLowerCase());

      const uri = await registryContract.tokenURI(status.tokenId);
      expect(uri).toBe("ipfs://QmSyncedTokenURI");
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // ERC-8041 Drop/Collection Tests
  // ═══════════════════════════════════════════════════════════════════════════

  describe("ERC-8041 Drop Collection", () => {
    it("returns correct initial status", async () => {
      const status = await dropService.getStatus();
      expect(status.dropEnabled).toBe(true);
      expect(status.publicMintOpen).toBe(true);
      expect(status.mintedOut).toBe(false);
      expect(status.currentSupply).toBe(0);
      expect(status.maxSupply).toBe(2138);
      expect(status.shinyPrice).toBe("0.1");
      expect(status.userHasMinted).toBe(false);
    });

    it("mints a free agent", async () => {
      const result = await dropService.mint(
        "FreeMintAgent",
        "http://localhost:7000/agent",
        ethers.id("free-mint"),
      );

      expect(result.agentId).toBeGreaterThan(0);
      expect(result.mintNumber).toBe(1);
      expect(result.isShiny).toBe(false);
      expect(result.txHash).toMatch(/^0x[a-fA-F0-9]{64}$/);
    });

    it("shows minted status after mint", async () => {
      const status = await dropService.getStatus();
      expect(status.currentSupply).toBe(1);
      expect(status.userHasMinted).toBe(true);
    });

    it("prevents double mint for same address", async () => {
      await expect(
        dropService.mint(
          "SecondMintAttempt",
          "http://localhost:8000/agent",
          ethers.id("second-attempt"),
        ),
      ).rejects.toThrow();
    });

    it("can query mint number", async () => {
      const mintNumber = await dropService.getMintNumber(1);
      expect(mintNumber).toBe(1);
    });

    it("can check shiny status", async () => {
      const isShiny = await dropService.checkIsShiny(1);
      expect(isShiny).toBe(false);
    });

    it("drop NFT ownership is queryable for inventory", async () => {
      const collectionContract = new ethers.Contract(
        contracts.collection.address,
        [
          "function balanceOf(address) view returns (uint256)",
          "function ownerOf(uint256) view returns (address)",
          "function tokenURI(uint256) view returns (string)",
        ],
        anvil.provider,
      );

      const balance = await collectionContract.balanceOf(TEST_ADDRESS);
      expect(Number(balance)).toBe(1);

      const owner = await collectionContract.ownerOf(1);
      expect(owner.toLowerCase()).toBe(TEST_ADDRESS.toLowerCase());

      const uri = await collectionContract.tokenURI(1);
      expect(["ipfs://QmElizaMetadata"]).toContain(uri);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Shiny Mint Tests (using different wallet)
  // ═══════════════════════════════════════════════════════════════════════════

  describe("Shiny Mint Flow", () => {
    // Use account #2 for shiny mint test
    const SHINY_PRIVATE_KEY =
      "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a";
    const SHINY_ADDRESS = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";

    let shinyTxService: TxService;
    let shinyDropService: DropService;

    beforeAll(async () => {
      // Fund the shiny wallet
      await anvil.fund(SHINY_ADDRESS, "1");

      shinyTxService = new TxService(anvil.rpcUrl, SHINY_PRIVATE_KEY);
      shinyDropService = new DropService(
        shinyTxService,
        contracts.collection.address,
        true,
      );
    });

    it("mints a shiny agent with 0.1 ETH", async () => {
      const result = await shinyDropService.mintShiny(
        "ShinyAgent",
        "http://localhost:9000/agent",
        ethers.id("shiny-mint"),
      );

      expect(result.agentId).toBeGreaterThan(0);
      expect(result.mintNumber).toBe(2);
      expect(result.isShiny).toBe(true);
      expect(result.txHash).toMatch(/^0x[a-fA-F0-9]{64}$/);
    });

    it("shiny status is correctly recorded", async () => {
      const isShiny = await shinyDropService.checkIsShiny(2);
      expect(isShiny).toBe(true);
    });

    it("shiny NFT has correct metadata URI", async () => {
      const collectionContract = new ethers.Contract(
        contracts.collection.address,
        ["function tokenURI(uint256) view returns (string)"],
        anvil.provider,
      );

      const uri = await collectionContract.tokenURI(2);
      expect(["ipfs://QmShinyElizaMetadata"]).toContain(uri);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Inventory Query Tests
  // ═══════════════════════════════════════════════════════════════════════════

  describe("NFT Inventory Queries", () => {
    it("returns all NFTs owned by test wallet", async () => {
      // Query both contracts for NFT balances
      const registryContract = new ethers.Contract(
        contracts.registry.address,
        ["function balanceOf(address) view returns (uint256)"],
        anvil.provider,
      );
      const collectionContract = new ethers.Contract(
        contracts.collection.address,
        ["function balanceOf(address) view returns (uint256)"],
        anvil.provider,
      );

      const [registryBalance, collectionBalance] = await Promise.all([
        registryContract.balanceOf(TEST_ADDRESS),
        collectionContract.balanceOf(TEST_ADDRESS),
      ]);

      // Test wallet should have 1 registry NFT and 1 collection NFT
      expect(Number(registryBalance)).toBe(1);
      expect(Number(collectionBalance)).toBe(1);
    });

    it("provides data for inventory display", async () => {
      // Simulate fetching inventory data
      const registryStatus = await registryService.getStatus();
      const dropStatus = await dropService.getStatus();

      const inventory = {
        agentIdentity: registryStatus.registered
          ? {
              tokenId: registryStatus.tokenId,
              name: registryStatus.agentName,
              endpoint: registryStatus.agentEndpoint,
              tokenURI: registryStatus.tokenURI,
              isActive: registryStatus.isActive,
            }
          : null,
        dropNFTs: dropStatus.userHasMinted
          ? {
              minted: true,
              supply: dropStatus.currentSupply,
              maxSupply: dropStatus.maxSupply,
            }
          : null,
      };

      expect(inventory.agentIdentity).not.toBeNull();
      expect(inventory.agentIdentity?.name).toBe("SyncedElizaAgent");
      expect(inventory.dropNFTs).not.toBeNull();
      expect(inventory.dropNFTs?.minted).toBe(true);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Multi-Wallet Mint Tests (simulating mint-out)
  // ═══════════════════════════════════════════════════════════════════════════

  describe("Multi-Wallet Minting", () => {
    it("multiple wallets can mint", async () => {
      // Use accounts #3, #4, #5 for additional mints
      // Run sequentially to avoid funder wallet nonce conflicts
      const additionalAccounts = anvil.accounts.slice(3, 6);
      const results = [];

      for (let idx = 0; idx < additionalAccounts.length; idx++) {
        const account = additionalAccounts[idx];
        await anvil.fund(account.address, "1");
        const svc = new TxService(anvil.rpcUrl, account.privateKey);
        const ds = new DropService(svc, contracts.collection.address, true);
        const result = await ds.mint(
          `MultiWalletAgent${idx}`,
          `http://localhost:1000${idx}/agent`,
          ethers.id(`multi-${idx}`),
        );
        results.push(result);
      }

      // Should have minted tokens 3, 4, 5
      expect(results[0].mintNumber).toBe(3);
      expect(results[1].mintNumber).toBe(4);
      expect(results[2].mintNumber).toBe(5);

      // Total supply should now be 5
      const status = await dropService.getStatus();
      expect(status.currentSupply).toBe(5);
    });

    it("tracks supply correctly", async () => {
      const status = await dropService.getStatus();
      expect(status.currentSupply).toBe(5);
      expect(status.mintedOut).toBe(false);
      expect(status.maxSupply - status.currentSupply).toBe(2133);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // TxService Tests (using shared Anvil instance)
  // ═══════════════════════════════════════════════════════════════════════════

  describe("TxService", () => {
    it("returns correct address", () => {
      expect(txService.address.toLowerCase()).toBe(TEST_ADDRESS.toLowerCase());
    });

    it("gets balance", async () => {
      const balance = await txService.getBalance();
      expect(balance).toBeGreaterThan(0n);
    });

    it("gets formatted balance", async () => {
      const formatted = await txService.getBalanceFormatted();
      expect(parseFloat(formatted)).toBeGreaterThan(4);
    });

    it("gets chain ID", async () => {
      const chainId = await txService.getChainId();
      expect(chainId).toBe(31337);
    });

    it("estimates gas", async () => {
      const gas = await txService.estimateGas({
        to: "0x0000000000000000000000000000000000000001",
        value: ethers.parseEther("0.001"),
      });
      expect(gas).toBeGreaterThan(0n);
    });

    it("gets fee data", async () => {
      const feeData = await txService.getFeeData();
      expect(feeData.gasPrice).not.toBeNull();
    });

    it("checks balance sufficiency", async () => {
      const hasEnough = await txService.hasEnoughBalance(
        ethers.parseEther("0.1"),
        21000n,
      );
      expect(hasEnough).toBe(true);
    });

    it("logs status without error", async () => {
      await expect(txService.logStatus()).resolves.not.toThrow();
    });
  });
});
