import { Provider, Memory, State, IAgentRuntime } from "@elizaos/core";
import { LitNodeClient } from "@lit-protocol/lit-node-client";
import { LitContracts } from "@lit-protocol/contracts-sdk";
import { LIT_RPC, LIT_NETWORK } from "@lit-protocol/constants";
import { AuthSig } from "@lit-protocol/auth-helpers";
import { PKPEthersWallet } from "@lit-protocol/pkp-ethers";
import * as ethers from "ethers";
import { LitConfigManager, LitConfig } from "../config/configManager.ts";
import * as solanaWeb3 from "@solana/web3.js";

export interface LitState {
  nodeClient: LitNodeClient;
  contractClient: LitContracts;
  authSig?: AuthSig;
  network?: string;
  evmWallet?: ethers.Wallet;
  pkp?: {
    tokenId: string;
    publicKey: string;
    ethAddress: string;
    solanaAddress?: string;
  };
  capacityCredit?: {
    tokenId: string;
  };
}

let executionCount = 0;

// Add a flag to track if the function is already running
let isExecutionInProgress = false;

export const litProvider: Provider = {
  get: async (
    runtime: IAgentRuntime,
    _message: Memory,
    state?: State & { lit?: LitState }
  ) => {
    // Guard against re-execution
    if (isExecutionInProgress) {
      console.log("Execution already in progress, skipping...");
      return;
    }

    try {
      isExecutionInProgress = true;

      // Initialize config manager
      const configManager = new LitConfigManager();

      // Try to load existing config
      const savedConfig = configManager.loadConfig();

      const provider = new ethers.providers.StaticJsonRpcProvider({
        url: LIT_RPC.CHRONICLE_YELLOWSTONE,
        skipFetchSetup: true,
      });

      // If we have saved config and no current state, initialize state from config
      if (savedConfig && !state?.lit?.pkp) {
        if (!state!.lit) {
          state!.lit = {} as LitState;
        }
        state!.lit.pkp = savedConfig.pkp;
        state!.lit.network = savedConfig.network;
        state!.lit.capacityCredit = savedConfig.capacityCredit;

        // Initialize wallet from saved private key
        if (savedConfig.evmWalletPrivateKey) {
          state!.lit.evmWallet = new ethers.Wallet(
            savedConfig.evmWalletPrivateKey,
            provider
          );
        }

        // Verify the saved config is still valid
        const isValid = await configManager.verifyConfig(savedConfig);
        if (!isValid) {
          console.log("Saved config is invalid, will create new PKP");
          state!.lit.pkp = undefined;
          state!.lit.evmWallet = undefined;
        }
      }

      // Strengthen the check for existing initialization
      if (state?.lit?.nodeClient && state?.lit?.contractClient) {
        console.log("📝 Reusing existing Lit environment", {
          network: state.lit.network,
          pkpAddress: state?.lit?.pkp?.ethAddress,
        });
        return `Reusing existing Lit environment on network ${state.lit.network}`;
      }

      // Only proceed with initialization if we don't have all required components

      // Initialize basic Lit client if not exists
      const litNodeClient =
        state?.lit?.nodeClient ||
        new LitNodeClient({
          litNetwork: LIT_NETWORK.DatilTest,
          debug: false,
        });

      if (!state?.lit?.nodeClient) {
        await litNodeClient.connect();
        console.log("✅ Connected to the Lit network");
      }

      const thisExecution = ++executionCount;
      console.log(`Starting execution #${thisExecution}`, {
        hasExistingClient: !!state?.lit?.nodeClient,
        messageId: _message?.id, // If messages have IDs
      });

      const network = await provider.getNetwork();
      const networkName =
        network.name !== "unknown"
          ? network.name
          : `Chain ID ${network.chainId}`;

      // Create funding wallet with provider
      const fundingWallet = new ethers.Wallet(
        runtime.getSetting("FUNDING_PRIVATE_KEY"),
        provider
      );

      // Initialize evmWallet first
      let evmWallet =
        state!.lit?.evmWallet || ethers.Wallet.createRandom().connect(provider);
      state!.lit =
        state!.lit ||
        ({
          nodeClient: litNodeClient,
          contractClient: {} as LitContracts,
          wallet: {} as PKPEthersWallet,
          evmWallet: evmWallet,
        } as LitState);

      // Initialize contract client with evmWallet as signer
      const contractClient = new LitContracts({
        network: LIT_NETWORK.DatilTest,
        signer: evmWallet,
      });
      await contractClient.connect();
      console.log("✅ Connected LitContracts client to network");

      let pkpPublicKey =
        runtime.getSetting("LIT_PKP_PUBLIC_KEY") || state?.lit?.pkp?.publicKey;

      // If no PKP exists, mint a new one
      if (!pkpPublicKey) {
        console.log("🔄 No PKP found. Creating new dual wallet...");

        if (!state!.lit) {
          state!.lit = {} as LitState;
        }
        let evmWallet =
          state!.lit.evmWallet ||
          ethers.Wallet.createRandom().connect(provider);

        // Make sure to store the wallet in the state
        state!.lit.evmWallet = evmWallet;

        // Generate Solana Wallet
        const svmWallet = solanaWeb3.Keypair.generate();

        // Check the balance of the funding wallet
        const balance = await provider.getBalance(fundingWallet.address);
        console.log(
          `Funding wallet balance: ${ethers.utils.formatEther(balance)} tstLPX`
        );

        // Fund the EVM wallet first
        try {
          console.log("Funding new EVM wallet with gas...");

          const tx = await fundingWallet.sendTransaction({
            to: evmWallet.address,
            value: ethers.utils.parseEther("0.006"),
            gasLimit: 21000,
          });

          console.log(`Funding transaction sent. Hash: ${tx.hash}`);
          const receipt = await tx.wait();
          console.log("💰 EVM Wallet funded successfully", {
            gasUsed: receipt.gasUsed.toString(),
            fundedAmount: "0.006",
          });

          const mintResult =
            await contractClient.pkpNftContractUtils.write.mint();

          console.log("✅ Dual PKP minted:", {
            tokenId: mintResult.pkp.tokenId,
            publicKey: mintResult.pkp.publicKey,
            ethAddress: mintResult.pkp.ethAddress,
            solanaAddress: svmWallet.publicKey.toString(),
          });

          pkpPublicKey = mintResult.pkp.publicKey;

          if (!state!.lit) {
            state!.lit = {} as LitState;
          }

          state!.lit.pkp = {
            tokenId: mintResult.pkp.tokenId,
            publicKey: mintResult.pkp.publicKey,
            ethAddress: mintResult.pkp.ethAddress,
            solanaAddress: svmWallet.publicKey.toString(),
          };

          const newConfig: LitConfig = {
            pkp: {
              tokenId: mintResult.pkp.tokenId,
              publicKey: mintResult.pkp.publicKey,
              ethAddress: mintResult.pkp.ethAddress,
              solanaAddress: svmWallet.publicKey.toString(),
            },
            network: networkName,
            timestamp: Date.now(),
            evmWalletPrivateKey: evmWallet.privateKey,
            solanaWalletPrivateKey: Buffer.from(svmWallet.secretKey).toString('base64'),
          };

          configManager.saveConfig(newConfig);
        } catch (error) {
          console.error("Failed to mint dual PKP:", error);
          throw error;
        }
      }

      // Mint capacity credit if not exists
      if (!state!.lit?.capacityCredit?.tokenId) {
        const capacityCreditClient = new LitContracts({
          network: LIT_NETWORK.DatilTest,
          signer: fundingWallet,
        });
        await capacityCreditClient.connect();
        console.log("🔄 Minting Capacity Credit NFT...");
        const capacityCreditInfo =
          await capacityCreditClient.mintCapacityCreditsNFT({
            requestsPerKilosecond: 80,
            daysUntilUTCMidnightExpiration: 1,
          });

        // Store the capacity credit token ID
        state!.lit!.capacityCredit = {
          tokenId: capacityCreditInfo.capacityTokenIdStr, // This is your resource ID
        };
        console.log(
          `✅ Minted Capacity Credit with ID: ${capacityCreditInfo.capacityTokenIdStr}`
        );

        // Save the updated config with capacity credit
        const currentConfig = configManager.loadConfig();
        const updatedConfig: LitConfig = {
          ...currentConfig,
          capacityCredit: {
            tokenId: capacityCreditInfo.capacityTokenIdStr,
          },
          timestamp: Date.now(),
        };
        configManager.saveConfig(updatedConfig);
      }

      // Update state with the initialized wallet and other components
      state!.lit = {
        nodeClient: litNodeClient,
        contractClient,
        network: networkName,
        evmWallet: evmWallet,
        pkp: state!.lit?.pkp || {
          tokenId: state!.lit?.pkp?.tokenId,
          publicKey: pkpPublicKey,
          ethAddress: state!.lit?.pkp?.ethAddress,
          solanaAddress: state!.lit?.pkp?.solanaAddress,
        },
        capacityCredit: state!.lit?.capacityCredit,
      };

      return `Lit environment initialized with network ${networkName}`;
    } finally {
      isExecutionInProgress = false;
    }
  },
};
