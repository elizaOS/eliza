import { Action, HandlerCallback, IAgentRuntime, Memory, State } from "@elizaos/core";
import { ethers } from "ethers";
import { LitNodeClient } from "@lit-protocol/lit-node-client";
import { LIT_RPC, LIT_ABILITY } from "@lit-protocol/constants";
import { LitPKPResource, createSiweMessageWithRecaps, generateAuthSig, LitActionResource } from "@lit-protocol/auth-helpers";
import { z } from "zod";
import { ModelClass, composeContext, generateObject, Content } from "@elizaos/core";

const USDC_CONTRACT_ADDRESS = "0x94a9D9AC8a22534E3FaCa9F4e7F2E2cf85d5E4C8"; // Sepolia USDC (AAVE)
const USDC_ABI = ["function transfer(address to, uint256 amount) returns (bool)"];

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
const sendUsdcTemplate = `Respond with a JSON markdown block containing only the extracted values. Use null for any values that cannot be determined.

Example response:
\`\`\`json
{
    "amount": "10",
    "to": "0x742d35Cc6634C0532925a3b844Bc454e4438f44e"
}
\`\`\`

{{recentMessages}}

Given the recent messages, extract the following information about the USDC transfer:
- amount (the amount of USDC to send)
- to (the destination address)

Respond with a JSON markdown block containing only the extracted values.`;

// Define the schema type
export const sendUsdcSchema = z.object({
    amount: z.string().nullable(),
    to: z.string().nullable()
});

// Add type guard function
function isSendUsdcContent(content: Content): content is SendUsdcContent {
    return (
        (typeof content.amount === "string" || content.amount === null) &&
        (typeof content.to === "string" || content.to === null)
    );
}

interface SendUsdcContent extends Content {
    amount: string | null;
    to: string | null;
}

export const sendUSDC: Action = {
  name: "SEND_USDC",
  description: "Sends USDC to an address on Sepolia using PKP wallet",
  similes: ["send usdc", "send * usdc to *", "transfer * usdc to *"],
  validate: async (_runtime: IAgentRuntime) => true,
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state: State,
    _options: Record<string, unknown>,
    callback?: HandlerCallback
  ): Promise<boolean> => {
    try {
      // Initialize or update state
      let currentState: State;
      if (!state) {
          currentState = (await runtime.composeState(message)) as State;
      } else {
          currentState = await runtime.updateRecentMessageState(state);
      }

      // Compose context and generate content
      const sendUsdcContext = composeContext({
        state: currentState,
        template: sendUsdcTemplate,
      });

      // Generate content with the schema
      const content = await generateObject({
        runtime,
        context: sendUsdcContext,
        schema: sendUsdcSchema as any,
        modelClass: ModelClass.LARGE,
      });

      const sendUsdcContent = content.object as SendUsdcContent;

      // Validate content
      if (!isSendUsdcContent(sendUsdcContent)) {
        console.error("Invalid content for SEND_USDC action.");
        callback?.({
          text: "Unable to process USDC transfer request. Invalid content provided.",
          content: { error: "Invalid send USDC content" }
        });
        return false;
      }

      if (!sendUsdcContent.amount) {
        console.log("Amount is not provided, skipping transfer");
        callback?.({ text: "The amount must be provided" });
        return false;
      }

      if (!sendUsdcContent.to) {
        console.log("Destination address is not provided, skipping transfer");
        callback?.({ text: "The destination address must be provided" });
        return false;
      }

      const amount = sendUsdcContent.amount;
      const to = sendUsdcContent.to;
      const litState = (state.lit || {}) as LitState;
      if (!litState.nodeClient || !litState.pkp || !litState.evmWallet || !litState.capacityCredit?.tokenId) {
        throw new Error("Lit environment not fully initialized");
      }

      const provider = new ethers.providers.JsonRpcProvider(runtime.getSetting("EVM_RPC_URL"));
      const usdcContract = new ethers.Contract(USDC_CONTRACT_ADDRESS, USDC_ABI, provider);
      const decimals = 6; // USDC has 6 decimals
      const value = ethers.utils.parseUnits(amount, decimals);

      const unsignedTx = await usdcContract.populateTransaction.transfer(to, value);
      unsignedTx.nonce = await provider.getTransactionCount(litState.pkp.ethAddress);
      unsignedTx.gasPrice = await provider.getGasPrice();
      unsignedTx.gasLimit = ethers.BigNumber.from(100000);
      unsignedTx.chainId = 11155111; // Sepolia

      const fundingWallet = new ethers.Wallet(
        runtime.getSetting("FUNDING_PRIVATE_KEY"),
        new ethers.providers.JsonRpcProvider(LIT_RPC.CHRONICLE_YELLOWSTONE)
      );

      const { capacityDelegationAuthSig } = await litState.nodeClient.createCapacityDelegationAuthSig({
        dAppOwnerWallet: fundingWallet,
        capacityTokenId: litState.capacityCredit.tokenId,
        delegateeAddresses: [litState.pkp.ethAddress],
        uses: "1",
        expiration: new Date(Date.now() + 1000 * 60 * 10).toISOString(),
      });

      const sessionSigs = await litState.nodeClient.getSessionSigs({
        pkpPublicKey: litState.pkp.publicKey,
        chain: "sepolia",
        capabilityAuthSigs: [capacityDelegationAuthSig],
        expiration: new Date(Date.now() + 1000 * 60 * 60 * 24).toISOString(),
        resourceAbilityRequests: [
          { resource: new LitPKPResource("*"), ability: LIT_ABILITY.PKPSigning },
          { resource: new LitActionResource("*"), ability: LIT_ABILITY.LitActionExecution },
        ],
        authNeededCallback: async ({ resourceAbilityRequests, expiration, uri }) => {
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
          return await generateAuthSig({ signer: litState.evmWallet, toSign });
        },
      });

      const sig = await litState.nodeClient.pkpSign({
        pubKey: litState.pkp.publicKey,
        toSign: ethers.utils.arrayify(ethers.utils.keccak256(ethers.utils.serializeTransaction(unsignedTx))),
        sessionSigs,
      });

      const signature = { r: `0x${sig.r}`, s: `0x${sig.s}`, v: sig.recid === 0 ? 27 : 28 };
      const signedTx = ethers.utils.serializeTransaction(unsignedTx, signature);
      const sentTx = await provider.sendTransaction(signedTx);
      await sentTx.wait();

      callback?.({
        text: `Successfully sent ${amount} USDC to ${to}. Transaction hash: ${sentTx.hash}`,
        content: { success: true, hash: sentTx.hash, amount, to },
      });
      return true;

    } catch (error) {
      console.error("Error in sendUSDC:", error);
      callback?.({
        text: `Failed to send USDC: ${error instanceof Error ? error.message : "Unknown error"}`,
        content: { success: false, error: error instanceof Error ? error.message : "Unknown error" },
      });
      return false;
    }
  },
  examples: [[
    { user: "{{user1}}", content: { text: "Send 10 USDC to 0x742d35Cc6634C0532925a3b844Bc454e4438f44e" }},
    { user: "{{user2}}", content: { text: "Successfully sent USDC" }}
  ]],
};