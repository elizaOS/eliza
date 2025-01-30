import {
    Action,
    HandlerCallback,
    IAgentRuntime,
    Memory,
    State,
    ModelClass,
    composeContext,
    generateObject,
    Content
  } from "@elizaos/core";
import { ethers } from "ethers";
import { LitNodeClient } from "@lit-protocol/lit-node-client";
import { LIT_RPC, LIT_ABILITY } from "@lit-protocol/constants";
  import {
    LitPKPResource,
    createSiweMessageWithRecaps,
    generateAuthSig,
    LitActionResource,
    AuthSig,
} from "@lit-protocol/auth-helpers";
import { z } from "zod";

interface LitState {
  nodeClient: LitNodeClient;
  evmWallet?: ethers.Wallet;
  pkp?: {
    publicKey: string;
    ethAddress: string;
  };
  capacityCredit?: {
    tokenId: string;
  };
}

// Add template for content extraction
const sendEthTemplate = `Respond with a JSON markdown block containing only the extracted values. Use null for any values that cannot be determined.

Example response:
\`\`\`json
{
    "amount": "0.01",
    "to": "0x742d35Cc6634C0532925a3b844Bc454e4438f44e"
}
\`\`\`

{{recentMessages}}

Given the recent messages, extract the following information about the ETH transfer:
- amount (the amount of ETH to send)
- to (the destination address)

Respond with a JSON markdown block containing only the extracted values.`;

// Define the schema type
const sendEthSchema = z.object({
    amount: z.string().nullable(),
    to: z.string().nullable()
});

// Add type guard function
function isSendEthContent(content: Content): content is SendEthContent {
  return (
    (typeof content.amount === "string" || content.amount === null) &&
    (typeof content.to === "string" || content.to === null)
  );
}

interface SendEthContent extends Content {
    amount: string | null;
    to: string | null;
}

export const sendEth: Action = {
  name: "SEND_ETH",
  description: "Sends ETH to an address on Sepolia using PKP wallet",
  similes: [
    "send eth",
    "send * eth to *",
    "send ethereum",
    "send * ETH to *",
    "transfer * eth to *",
    "transfer * ETH to *",
  ],
  validate: async (_runtime: IAgentRuntime) => true,
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state: State,
    _options: Record<string, unknown>,
    callback?: HandlerCallback
  ): Promise<boolean> => {
    console.log("SEND_ETH handler started");
    try {
      // Initialize or update state
      let currentState: State;
      if (!state) {
          currentState = (await runtime.composeState(message)) as State;
      } else {
          currentState = await runtime.updateRecentMessageState(state);
      }
      // Compose context and generate content
      const sendEthContext = composeContext({
        state: currentState,
        template: sendEthTemplate,
      });

      // Generate content with the schema
      const content = await generateObject({
        runtime,
        context: sendEthContext,
        schema: sendEthSchema as any,
        modelClass: ModelClass.LARGE,
      });

      const sendEthContent = content.object as SendEthContent;

      // Validate content
      if (!isSendEthContent(sendEthContent)) {
        console.error("Invalid content for SEND_ETH action.");
        callback?.({
          text: "Unable to process ETH transfer request. Invalid content provided.",
          content: { error: "Invalid send ETH content" }
        });
        return false;
      }

      if (!sendEthContent.amount) {
        console.log("Amount is not provided, skipping transfer");
        callback?.({ text: "The amount must be provided" });
        return false;
      }

      if (!sendEthContent.to) {
        console.log("Destination address is not provided, skipping transfer");
        callback?.({ text: "The destination address must be provided" });
        return false;
      }

      // Validate amount format
      const cleanedAmount = sendEthContent.amount.replace(/[^\d.]/g, '');
      const parsedAmount = Number.parseFloat(cleanedAmount);
      if (Number.isNaN(parsedAmount) || parsedAmount <= 0) {
        throw new Error(`Invalid amount value: ${sendEthContent.amount}`);
      }

      // Validate address format
      if (!/^0x[a-fA-F0-9]{40}$/.test(sendEthContent.to)) {
        throw new Error(`Invalid Ethereum address: ${sendEthContent.to}`);
      }

      // Validate Lit environment
      const litState = (state.lit || {}) as LitState;
      if (
        !litState.nodeClient ||
        !litState.pkp ||
        !litState.evmWallet ||
        !litState.capacityCredit?.tokenId
      ) {
        throw new Error(
          "Lit environment not fully initialized - missing nodeClient, pkp, evmWallet, or capacityCredit"
        );
      }

      // Get RPC URL from runtime settings
      const rpcUrl = runtime.getSetting("EVM_RPC_URL");
      if (!rpcUrl) {
        throw new Error("No RPC URL provided");
      }

      const provider = new ethers.providers.JsonRpcProvider(rpcUrl);

      // Create transaction
      const nonce = await provider.getTransactionCount(litState.pkp.ethAddress);
      const gasPrice = await provider.getGasPrice();
      const gasLimit = 30000;

      const unsignedTx = {
        to: sendEthContent.to,
        value: ethers.utils.parseEther(sendEthContent.amount),
        chainId: 11155111, // Sepolia chainId
        nonce: nonce,
        gasPrice: gasPrice,
        gasLimit: gasLimit,
      };

      const fundingWallet = new ethers.Wallet(
        runtime.getSetting("FUNDING_PRIVATE_KEY"),
        new ethers.providers.JsonRpcProvider(LIT_RPC.CHRONICLE_YELLOWSTONE)
      );

      const { capacityDelegationAuthSig } =
        await litState.nodeClient.createCapacityDelegationAuthSig({
          dAppOwnerWallet: fundingWallet,
          capacityTokenId: litState.capacityCredit.tokenId,
          delegateeAddresses: [litState.pkp.ethAddress],
          uses: "1",
          expiration: new Date(Date.now() + 1000 * 60 * 10).toISOString(), // 10 minutes
        });

      // Get session signatures with capacity delegation
      console.log("Generating session signatures with capacity delegation...");
      const sessionSigs = await litState.nodeClient.getSessionSigs({
        pkpPublicKey: litState.pkp.publicKey,
        chain: "sepolia",
        capabilityAuthSigs: [capacityDelegationAuthSig],
        expiration: new Date(Date.now() + 1000 * 60 * 60 * 24).toISOString(), // 24 hours
        resourceAbilityRequests: [
          {
            resource: new LitPKPResource("*"),
            ability: LIT_ABILITY.PKPSigning,
          },
          {
            resource: new LitActionResource("*"),
            ability: LIT_ABILITY.LitActionExecution,
          },
        ],
        authNeededCallback: async ({
          resourceAbilityRequests,
          expiration,
          uri,
        }) => {
          if (!uri || !expiration || !resourceAbilityRequests) {
            throw new Error("Missing required parameters for auth callback");
          }
          const toSign = await createSiweMessageWithRecaps({
            uri,
            expiration,
            resources: resourceAbilityRequests,
            walletAddress: litState.evmWallet.address,
            nonce: await litState.nodeClient.getLatestBlockhash(),
            litNodeClient: litState.nodeClient,
          });

          return await generateAuthSig({
            signer: litState.evmWallet,
            toSign,
          });
        },
      });
      console.log("Session signatures generated");

      console.log("Signing transaction...");
      const sig = await litState.nodeClient.pkpSign({
        pubKey: litState.pkp.publicKey,
        toSign: ethers.utils.arrayify(
          ethers.utils.keccak256(ethers.utils.serializeTransaction(unsignedTx))
        ),
        sessionSigs,
      });

      // Combine signature with transaction
      const signature = {
        r: `0x${sig.r}`,
        s: `0x${sig.s}`,
        v: sig.recid === 0 ? 27 : 28,
      };

      // Verify signature by recovering the address
      const msgHash = ethers.utils.keccak256(
        ethers.utils.serializeTransaction(unsignedTx)
      );
      const recoveredAddress = ethers.utils.recoverAddress(msgHash, signature);

      // If address doesn't match, try the other v value
      if (
        recoveredAddress.toLowerCase() !== litState.pkp.ethAddress.toLowerCase()
      ) {
        signature.v = signature.v === 27 ? 28 : 27; // Toggle between 27 and 28
        const altRecoveredAddress = ethers.utils.recoverAddress(
          msgHash,
          signature
        );

        if (
          altRecoveredAddress.toLowerCase() !==
          litState.pkp.ethAddress.toLowerCase()
        ) {
          throw new Error("Failed to recover correct address from signature");
        }
      }

      const signedTx = ethers.utils.serializeTransaction(unsignedTx, signature);

      // Send transaction
      console.log("Sending transaction...");
      const sentTx = await provider.sendTransaction(signedTx);
      await sentTx.wait();

      callback?.({
        text: `Successfully sent ${sendEthContent.amount} ETH to ${sendEthContent.to}. Transaction hash: ${sentTx.hash}`,
        content: {
          success: true,
          hash: sentTx.hash,
          amount: sendEthContent.amount,
          to: sendEthContent.to,
        },
      });

      return true;
    } catch (error) {
      console.error("Error in sendEth:", error);
      callback?.({
        text: `Failed to send ETH: ${
          error instanceof Error ? error.message : "Unknown error"
        }`,
        content: {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        },
      });
      return false;
    }
  },
  examples: [
    [
      {
        user: "{{user1}}",
        content: {
          text: "Send 0.01 ETH to 0x742d35Cc6634C0532925a3b844Bc454e4438f44e",
        },
      },
      {
        user: "{{user2}}",
        content: {
          text: "Successfully sent ETH",
        },
      },
    ],
  ],
};
