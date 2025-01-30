import { ethers } from 'ethers';
import {
  Action,
  composeContext,
  generateObjectDeprecated,
  HandlerCallback,
  ModelClass,
  type IAgentRuntime,
  type Memory,
  type State,
} from "@elizaos/core";
import { LIT_NETWORK, LIT_ABILITY } from '@lit-protocol/constants';
import { UniswapSwap, UniswapSwapLitActionParameters } from "./tool"; // Import the UniswapSwap tool
import { uniswapSwapTemplate } from "../../../templates"; // Assuming you have a template for Uniswap swaps
import { UniswapSwapPolicy } from './policy';
import { IPFS_CIDS } from './ipfs';
import LitJsSdk from '@lit-protocol/lit-node-client';
import {
  LitActionResource,
  createSiweMessage,
  generateAuthSig,
} from "@lit-protocol/auth-helpers";

/**
 * Builds the details required for a Uniswap swap Lit Action.
 * @param {State} state - The current state of the agent.
 * @param {IAgentRuntime} runtime - The runtime instance of the agent.
 * @returns {Promise<UniswapSwapLitActionParameters>} - The parameters for the Uniswap swap.
 */
const buildUniswapSwapDetails = async (
  state: State,
  runtime: IAgentRuntime
): Promise<UniswapSwapLitActionParameters> => {
  const context = composeContext({
    state,
    template: uniswapSwapTemplate, // Use the Uniswap swap template
  });

  const swapDetails = (await generateObjectDeprecated({
    runtime,
    context,
    modelClass: ModelClass.SMALL,
  })) as UniswapSwapLitActionParameters;

  return swapDetails;
};

/**
 * Action for executing a Uniswap swap using the Lit Protocol.
 */
export const UNISWAP_SWAP_LIT_ACTION: Action = {
  name: "uniswap-swap",
  similes: ["Uniswap Swap", "Swap Tokens", "Execute Uniswap Swap"],
  description: "This interacts with Lit Protocol to execute a Uniswap swap using the UniswapSwap tool.",
  validate: async (runtime: IAgentRuntime, message: Memory) => {
    const privateKey = runtime.getSetting("EVM_PRIVATE_KEY");
    return typeof privateKey === "string" && privateKey.startsWith("0x");
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state: State,
    options?: any,
    callback?: HandlerCallback
  ) => {
    try {
      const swapDetails = await buildUniswapSwapDetails(state, runtime);

      // Get the appropriate tool for the network
      const tool = UniswapSwap[LIT_NETWORK.DatilDev]; // Assuming you're using the DatilDev network

      // Validate the parameters
      const validationResult = tool.parameters.validate(swapDetails);
      if (validationResult !== true) {
        const errors = validationResult.map(err => `${err.param}: ${err.error}`).join(', ');
        throw new Error(`Invalid parameters: ${errors}`);
      }

      // Create and validate policy
      const policy = {
        type: "UniswapSwap" as const,
        version: UniswapSwapPolicy.version,
        tokenIn: swapDetails.tokenIn,
        tokenOut: swapDetails.tokenOut,
        amountIn: swapDetails.amountIn,
        maxSlippage: "0.5", // Example slippage tolerance (0.5%)
      };

      // Validate policy against schema
      UniswapSwapPolicy.schema.parse(policy);

      // Encode policy for execution
      const encodedPolicy = UniswapSwapPolicy.encode(policy);

      // Get IPFS CID for the network
      const ipfsCid = IPFS_CIDS['datil-dev'].tool;

      // Initialize Lit client
      const litNodeClient = new LitJsSdk.LitNodeClient({
        alertWhenUnauthorized: false,
        litNetwork: LIT_NETWORK.DatilDev,
        debug: false,
      });
      await litNodeClient.connect();

      // Get wallet from private key
      const wallet = new ethers.Wallet(runtime.getSetting("EVM_PRIVATE_KEY"));

      // Get session signatures
      const sessionSigs = await litNodeClient.getSessionSigs({
        chain: "ethereum",
        expiration: new Date(Date.now() + 1000 * 60 * 10).toISOString(), // 10 minutes
        resourceAbilityRequests: [
          {
            resource: new LitActionResource("*"),
            ability: LIT_ABILITY.LitActionExecution,
          },
        ],
        authNeededCallback: async ({ uri, expiration, resourceAbilityRequests }) => {
          const toSign = await createSiweMessage({
            uri,
            expiration,
            resources: resourceAbilityRequests,
            walletAddress: wallet.address,
            nonce: await litNodeClient.getLatestBlockhash(),
            litNodeClient,
          });

          return await generateAuthSig({
            signer: wallet,
            toSign,
          });
        },
      });

      // Execute the Lit Action
      const response = await litNodeClient.executeJs({
        sessionSigs,
        ipfsId: ipfsCid,
        jsParams: {
          params: {
            ...swapDetails,
            encodedPolicy,
          },
        },
      });

      console.log("UniswapSwap Response:", response);

      if (callback) {
        callback({
          text: `Uniswap swap executed successfully. Response: ${JSON.stringify(response)}`,
          content: {
            success: true,
            response: response,
          },
        });
      }

      return true;

    } catch (error) {
      console.error("Error in UniswapSwap handler:", error);

      if (callback) {
        callback({
          text: `Error executing Uniswap swap: ${error.message}`,
          content: {
            error: error.message,
          },
        });
      }

      throw error;
    }
  },
  examples: [
    [
      {
        user: "{{user1}}",
        content: { text: "please attempt a Uniswap swap pkp addy: 0xc8BB61FB32cbfDc0534136798099709d779086b4 rpc: https://base-sepolia-rpc.publicnode.com chain ID 84532 tokenIn address 0x00cdfea7e11187BEB4a0CE835fea1745b124B26e tokenOut address 0xDFdC570ec0586D5c00735a2277c21Dcc254B3917 amountIn 1" },
      },
      {
        user: "{{user2}}",
        content: { text: "Executing Uniswap swap", action: "UNISWAP_SWAP_LIT_ACTION" },
      },
    ],
  ],
};
