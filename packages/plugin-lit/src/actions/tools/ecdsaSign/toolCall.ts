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
import { SignEcdsa, SignEcdsaLitActionParameters } from "./tool"; // Import the SignEcdsa tool
import { ecdsaSignTemplate } from "../../../templates"; // Assuming you have a template for ECDSA signing
import { SignEcdsaPolicy } from './policy';
import { IPFS_CIDS } from './ipfs';
import LitJsSdk from '@lit-protocol/lit-node-client';
import {
  LitActionResource,
  createSiweMessage,
  generateAuthSig,
} from "@lit-protocol/auth-helpers";

/**
 * Builds the details required for an ECDSA signing Lit Action.
 * @param {State} state - The current state of the agent.
 * @param {IAgentRuntime} runtime - The runtime instance of the agent.
 * @returns {Promise<SignEcdsaLitActionParameters>} - The parameters for the ECDSA signing.
 */
const buildEcdsaSignDetails = async (
  state: State,
  runtime: IAgentRuntime
): Promise<SignEcdsaLitActionParameters> => {
  const context = composeContext({
    state,
    template: ecdsaSignTemplate, // Use the ECDSA signing template
  });

  const signDetails = (await generateObjectDeprecated({
    runtime,
    context,
    modelClass: ModelClass.SMALL,
  })) as SignEcdsaLitActionParameters;

  return signDetails;
};

/**
 * Action for executing an ECDSA signing using the Lit Protocol.
 */
export const ECDSA_SIGN_LIT_ACTION: Action = {
  name: "ecdsa-sign",
  similes: ["ECDSA Sign", "Sign Message", "Execute ECDSA Sign"],
  description: "This interacts with Lit Protocol to sign a message using the SignEcdsa tool.",
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
      const signDetails = await buildEcdsaSignDetails(state, runtime);

      // Get the appropriate tool for the network
      const tool = SignEcdsa[LIT_NETWORK.DatilDev]; // Assuming you're using the DatilDev network

      // Validate the parameters
      const validationResult = tool.parameters.validate(signDetails);
      if (validationResult !== true) {
        const errors = validationResult.map(err => `${err.param}: ${err.error}`).join(', ');
        throw new Error(`Invalid parameters: ${errors}`);
      }

      // Create and validate policy
      const policy = {
        type: "SignEcdsa" as const,
        version: SignEcdsaPolicy.version,
        allowedMessages: [signDetails.message], // Allow only the specific message to be signed
      };

      // Validate policy against schema
      SignEcdsaPolicy.schema.parse(policy);

      // Encode policy for execution
      const encodedPolicy = SignEcdsaPolicy.encode(policy);

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
            ...signDetails,
            encodedPolicy,
          },
        },
      });

      console.log("ECDSA Sign Response:", response);

      if (callback) {
        callback({
          text: `Message signed successfully. Response: ${JSON.stringify(response)}`,
          content: {
            success: true,
            response: response,
          },
        });
      }

      return true;

    } catch (error) {
      console.error("Error in ECDSA Sign handler:", error);

      if (callback) {
        callback({
          text: `Error signing message: ${error.message}`,
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
        content: { text: "please sign the message 'Hello, world!' with PKP address 0xc8BB61FB32cbfDc0534136798099709d779086b4" },
      },
      {
        user: "{{user2}}",
        content: { text: "Executing ECDSA sign", action: "ECDSA_SIGN_LIT_ACTION" },
      },
    ],
  ],
};
