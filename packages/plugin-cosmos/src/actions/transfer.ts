import {
    ActionExample,
    Content,
    HandlerCallback,
    IAgentRuntime,
    Memory,
    ModelClass,
    State,
    type Action,
    composeContext,
    generateObject,
  } from "@ai16z/eliza";
  import { chains } from "chain-registry";
  import { getOfflineSignerProto as getOfflineSigner } from "cosmjs-utils";
  import { SigningStargateClient } from "@cosmjs/stargate";
  import { coins, StdFee } from "@cosmjs/amino";

  export interface TransferContent extends Content {
    recipient: string;
    amount: string | number;
    tokenAddress?: string; // optional if we want to handle cw20 or other tokens
  }

  function isTransferContent(
    runtime: IAgentRuntime,
    content: any
  ): content is TransferContent {
    return (
      typeof content.recipient === "string" &&
      (typeof content.amount === "string" || typeof content.amount === "number")
    );
  }

  const transferTemplate = `Respond with a JSON markdown block containing only the extracted values. Use null for any values that cannot be determined.

  Example response:
  \`\`\`json
  {
    "recipient": "osmo1abcd1234...",
    "amount": "1.5",
    "tokenAddress": null
  }
  \`\`\`

  {{recentMessages}}

  Given the recent messages and wallet information below:

  {{walletInfo}}

  Extract the following information about the requested token transfer:
  - Recipient address
  - Amount to transfer
  - Token contract address (null for native transfers)

  Respond with a JSON markdown block containing only the extracted values.
  `;

  /**
   * Quickly checks if an RPC endpoint is reachable by fetching /status.
   * Return true if ok, false if not.
   */
  async function canGetStatus(rpcUrl: string): Promise<boolean> {
    try {
      const url = rpcUrl.endsWith("/") ? rpcUrl + "status" : `${rpcUrl}/status`;
      const response = await fetch(url, { method: "GET" });
      if (!response.ok) {
        throw new Error(`RPC /status responded with HTTP ${response.status}`);
      }
      return true;
    } catch {
      return false;
    }
  }

  async function getWorkingRpcUrl(rpcUrls: string[]): Promise<string | null> {
    for (const url of rpcUrls) {
      if (await canGetStatus(url)) {
        return url;
      }
    }
    return null;
  }

  /**
   * Transfer tokens, preferring env-based RPC/DENOM/DECIMALS, else chain-registry.
   */
  async function transferTokens(
    runtime: IAgentRuntime,
    recipient: string,
    amount: string
  ): Promise<string> {
    // 1) Identify chain + mnemonic
    const chainName = runtime.getSetting("COSMOS_CHAIN_NAME") || "osmosis";
    const mnemonic = runtime.getSetting("COSMOS_MNEMONIC");
    if (!mnemonic) {
      throw new Error("COSMOS_MNEMONIC not configured");
    }

    // 2) Lookup chain in registry
    const chain = chains.find((c) => c.chain_name === chainName);
    if (!chain) {
      throw new Error(`Chain '${chainName}' not found in chain-registry`);
    }

    // 3) Build a candidate RPC list
    // First, check env-based RPC
    const candidateRpcs: string[] = [];
    const envRpc = runtime.getSetting("COSMOS_RPC_URL");
    if (envRpc) {
      candidateRpcs.push(envRpc);
    }
    // Then add chain-registry RPC endpoints
    const registryRpcs = chain.apis?.rpc?.map((r) => r.address) ?? [];
    candidateRpcs.push(...registryRpcs);

    // 4) Find a working RPC by checking /status
    const workingRpc = await getWorkingRpcUrl(candidateRpcs);
    if (!workingRpc) {
      throw new Error(`No working RPC endpoint found for '${chainName}'`);
    }

    // 5) Determine denom & decimals
    // - If env is set, prefer that
    // - else fallback to chain.fees
    const chainFees = chain.fees?.fee_tokens?.[0];
    const envDenom = runtime.getSetting("COSMOS_DENOM");
    const envDecimals = runtime.getSetting("COSMOS_DECIMALS");

    const defaultDenom = chainFees?.denom || "uosmo";
    const denom = envDenom || defaultDenom;
    const decimals = envDecimals ? Number(envDecimals) : 6; // or read from chain data

    // average gas price
    const averageGasPrice = chainFees?.average_gas_price ?? 0.025;

    // 6) Create offline signer
    const signer = await getOfflineSigner({
      mnemonic,
      chain,
    });

    // 7) Connect Stargate client w/ signer
    const stargateClient = await SigningStargateClient.connectWithSigner(
      workingRpc,
      signer
    );

    // 8) Build the transaction
    const [fromAccount] = await signer.getAccounts();
    const fromAddress = fromAccount.address;
    const shift = 10 ** decimals;
    const sendAmount = String(Math.floor(Number(amount) * shift));

    const msg = {
      typeUrl: "/cosmos.bank.v1beta1.MsgSend",
      value: {
        fromAddress,
        toAddress: recipient,
        amount: coins(sendAmount, denom),
      },
    };
    const messages = [msg];
    const memo = "";

    // 9) Estimate gas usage
    const gasEstimated = await stargateClient.simulate(fromAddress, messages, memo);
    const feeAmount = Math.floor(gasEstimated * averageGasPrice).toString();

    const fee: StdFee = {
      amount: coins(feeAmount, denom),
      gas: gasEstimated.toString(),
    };

    // 10) Sign & broadcast
    const result = await stargateClient.signAndBroadcast(
      fromAddress,
      messages,
      fee,
      memo
    );

    return result.transactionHash;
  }

  export const executeTransfer: Action = {
    name: "SEND_COSMOS",
    similes: ["TRANSFER_COSMOS", "SEND_TOKENS", "TRANSFER_TOKENS", "PAY_COSMOS"],
    validate: async (_runtime: IAgentRuntime, _message: Memory) => {
      // Add your validation logic if needed
      return true;
    },
    description: "Transfer native Cosmos tokens to another address",
    handler: async (
      runtime: IAgentRuntime,
      message: Memory,
      state: State,
      _options: { [key: string]: unknown },
      callback?: HandlerCallback
    ): Promise<boolean> => {
      // 1) Ensure up-to-date state
      if (!state) {
        state = (await runtime.composeState(message)) as State;
      } else {
        state = await runtime.updateRecentMessageState(state);
      }

      // 2) Compose transfer context
      const transferContext = composeContext({
        state,
        template: transferTemplate,
      });

      // 3) Generate JSON from user conversation
      const content = await generateObject({
        runtime,
        context: transferContext,
        modelClass: ModelClass.SMALL,
      });

      // 4) Validate
      if (!isTransferContent(runtime, content)) {
        console.error("Invalid content for SEND_COSMOS action.");
        if (callback) {
          callback({
            text: "Unable to process transfer request. Invalid content provided.",
            content: { error: "Invalid transfer content" },
          });
        }
        return false;
      }

      try {
        // 5) Transfer
        const txHash = await transferTokens(
          runtime,
          content.recipient,
          content.amount.toString()
        );

        // 6) If successful
        if (callback) {
          callback({
            text: `Successfully transferred ${content.amount} tokens to ${content.recipient}\nTransaction: ${txHash}`,
            content: {
              success: true,
              signature: txHash,
              amount: content.amount,
              recipient: content.recipient,
            },
          });
        }
        return true;
      } catch (error) {
        console.error("Error during Cosmos transfer:", error);
        if (callback) {
          callback({
            text: `Error transferring tokens: ${error}`,
            content: { error },
          });
        }
        return false;
      }
    },

    // 7) Example usage
    examples: [
      [
        {
          user: "{{user1}}",
          content: {
            text: "Send 1.5 tokens to osmo1abcd1234...",
          },
        },
        {
          user: "{{user2}}",
          content: {
            text: "I'll send 1.5 OSMO now...",
            action: "SEND_COSMOS",
          },
        },
        {
          user: "{{user2}}",
          content: {
            text: "Successfully sent 1.5 OSMO to osmo1abcd1234...\nTransaction: ABC123XYZ",
          },
        },
      ],
    ] as ActionExample[][],
  } as Action;
