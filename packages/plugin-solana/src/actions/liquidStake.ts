// Import required dependencies from Solana web3 and other libraries
import {
    Connection,
    PublicKey,
    TransactionMessage,
    VersionedTransaction,
} from "@solana/web3.js";
import { depositSol } from "@solana/spl-stake-pool";
import {
    ActionExample,
    composeContext,
    elizaLogger,
    generateObject,
    HandlerCallback,
    IAgentRuntime,
    Memory,
    ModelClass,
    State,
} from "@elizaos/core";
import bs58 from "bs58";
import {
    Marinade,
    MarinadeConfig,
    MarinadeUtils,
} from "@marinade.finance/marinade-ts-sdk";
import {
    SelectedPool,
    SelectedPoolSchema,
    StakeConfig,
    StakeParams,
    StakeParamsSchema,
    StakePool,
    StakePoolsType,
} from "../types/stake.ts";
import { StakeProtocolProvider } from "../providers/stakeProtocol.ts";

// Initialize Solana connection to mainnet
const connection = new Connection("https://api.mainnet-beta.solana.com");

// Initialize stake protocol provider with connection
const provider = new StakeProtocolProvider(connection);

// Define available stake pools with their addresses and protocol names
export const STAKE_POOLS: StakePoolsType = {
    jito: {
        address: "Jito4APyf642JPZPx3hGc6WWJ8zPKtRbRs4P815Awbb",
        protocolName: "Jito",
    },
    blaze: {
        address: "stk9ApL5HeVAwPLr3TLhDXdZS8ptVu7zp6ov8HFDuMi",
        protocolName: "Blaze",
    },
    marginfi: {
        address: "DqhH94PjkZsjAqEze2BEkWhFQJ6EyU6MdtMphMgnXqeK",
        protocolName: "Marginfi",
    },
    jpool: {
        address: "CtMyWsrUtAwXWiGr9WjHT5fC3p3fgV8cyGpLTo2LJzG1",
        protocolName: "JPool",
    },
    marinade: {
        address: "MckGXZC1GbLqTK1vaSWsjRvWg5G3tj8hpXfaHYBqqKy",
        protocolName: "Marinade",
    },
};

// Configuration for stake action including name and alternative command phrases
const config: StakeConfig = {
    name: "STAKE_SOL",
    similes: [
        "STAKE_LIQUID_SOL",
        "STAKE_SOL_IN_JITO",
        "STAKE_SOL_IN_BLAZE",
        "STAKE_SOL_IN_MARGINFI",
        "STAKE_SOL_IN_JPOOL",
        "STAKE_SOL_IN_MARINADE",
        "STAKE_BLAZE_SOL",
        "STAKE_MARGINFI_SOL",
        "STAKE_JITO_SOL",
        "STAKE_JPOOL_SOL",
        "STAKE_MARINADE_SOL",
    ],
    pools: STAKE_POOLS,
};

// Type guard to validate stake parameters
function isStakeParams(content: any): content is StakeParams {
    elizaLogger.log("Content for stake sol", content);
    return (
        typeof content.userAddress === "string" &&
        (typeof content.amountSol === "number" ||
            typeof content.amountSol === "string")
    );
}

/**
 * Selects and validates a staking pool based on user input or automatic selection
 * @param runtime Agent runtime environment
 * @param state Current state
 * @param poolName Optional pool name specified by user
 * @param callback Optional callback for status updates
 * @returns Selected pool info or error
 */
async function selectAndValidatePool(
    runtime: IAgentRuntime,
    state: State,
    poolName: string | null,
    callback?: HandlerCallback
): Promise<{ pool: StakePool | null; error?: string }> {
    let finalPoolName = poolName;

    // If no pool specified, select best pool based on metrics
    if (finalPoolName === "" || finalPoolName === null) {
        elizaLogger.log("Selecting best pool...");

        state.poolData = await provider.getStakePoolInfo();
        const selectionPoolContext = composeContext({
            state,
            template: selectionPoolTemplate,
        });

        elizaLogger.info("Generating selection pool content...");
        const selectedPoolResp = await generateObject({
            runtime,
            context: selectionPoolContext,
            modelClass: ModelClass.MEDIUM,
            schema: SelectedPoolSchema,
        });

        const { selectedPool, reason } =
            selectedPoolResp.object as SelectedPool;

        elizaLogger.log(`Selected pool reason: ${reason}`);

        if (!selectedPool) {
            elizaLogger.error("Invalid selected pool.");
            if (callback) {
                callback({
                    text: "Unable to process stake request. Invalid selected pool.",
                    content: {
                        error: "Invalid selected pool",
                    },
                });
            }
            return { pool: null, error: "Invalid selected pool" };
        }
        finalPoolName = selectedPool;
    }

    // Validate pool exists in config
    const pool = config.pools[finalPoolName.toLowerCase()];

    if (!pool) {
        elizaLogger.error(`Invalid pool name: ${finalPoolName}`);
        if (callback) {
            callback({
                text: `Invalid pool name: ${finalPoolName}. Please choose either "jito" or "blaze".`,
                content: {
                    error: "Invalid pool name",
                },
            });
        }
        return { pool: null, error: "Invalid pool name" };
    }

    elizaLogger.log(`selected pool: ${pool.address} ${pool.protocolName}`);
    return { pool };
}

// Main action handler for staking SOL
export default {
    name: config.name,
    similes: config.similes,
    validate: async (_runtime: IAgentRuntime, _message: Memory) => {
        // Basic validation - could be extended for more checks
        return true;
    },
    description: `Stake SOL in liquid Protocol. This action requires the user to provide the user address, amount of SOL to stake.`,
    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        state: State,
        _options: { [key: string]: unknown },
        callback?: HandlerCallback
    ): Promise<boolean> => {
        elizaLogger.log("Starting STAKE_SOL handler...");

        // Initialize or update state
        if (!state) {
            state = await runtime.composeState(message);
        } else {
            state = await runtime.updateRecentMessageState(state);
        }

        // Generate stake parameters from user input
        const stakeContext = composeContext({
            state,
            template: createStakeTemplate,
        });

        elizaLogger.info("Generating stake content...");

        const contentFromSchema = await generateObject({
            runtime,
            context: stakeContext,
            modelClass: ModelClass.SMALL,
            schema: StakeParamsSchema,
        });

        const content = contentFromSchema.object as StakeParams;

        // Validate stake parameters
        if (!isStakeParams(content)) {
            elizaLogger.error("Invalid content for stake action.");
            if (callback) {
                callback({
                    text: "Unable to process stake request. Invalid content provided.",
                    content: {
                        error: "Invalid stake content",
                    },
                });
            }
            return false;
        }

        const userAddress = content.userAddress;
        const amountSol = parseFloat(content.amountSol as string);

        // Select and validate staking pool
        const poolResult = await selectAndValidatePool(
            runtime,
            state,
            content.poolName,
            callback
        );
        if (!poolResult.pool) {
            return false;
        }

        const userPublicKey = new PublicKey(userAddress);
        const STAKE_POOL = new PublicKey(poolResult.pool.address);
        let depositResult: {
            transaction: VersionedTransaction;
            rentFee: number;
        };

        try {
            // Handle deposit based on protocol type
            if (poolResult.pool.protocolName.toLowerCase() == "marinade") {
                depositResult = await depositSolToMarinade(
                    connection,
                    userPublicKey,
                    amountSol
                );
            } else {
                depositResult = await depositSolToPool(
                    connection,
                    STAKE_POOL,
                    userPublicKey,
                    amountSol
                );
            }

            elizaLogger.log("Preparing to sign transaction...");

            // Serialize and encode transaction for transmission
            const serializedTx = depositResult.transaction.serialize();
            const base58Tx = bs58.encode(serializedTx);

            const responseMsg = {
                text: JSON.stringify({
                    action: config.name,
                    amountSol,
                    userAddress,
                    protocol: poolResult.pool.protocolName,
                    transaction: base58Tx,
                }),
            };

            callback?.(responseMsg);

            return true;
        } catch (error) {
            elizaLogger.error("Error during sol stake:", error);
            if (callback) {
                callback({
                    text: `Error during staking: ${error.message}`,
                });
            }
            return false;
        }
    },
    examples: createStakeExamples(config),
};

/**
 * Deposits SOL to Marinade Finance protocol
 * @param connection Solana connection
 * @param from User's public key
 * @param amountSol Amount of SOL to stake
 * @returns Transaction and rent fee
 */
export async function depositSolToMarinade(
    connection: Connection,
    from: PublicKey,
    amountSol: number
): Promise<{ transaction: VersionedTransaction; rentFee: number }> {
    const config = new MarinadeConfig({
        connection,
        publicKey: from,
    });
    const marinade = new Marinade(config);

    // Create deposit transaction
    const { transaction } = await marinade.deposit(
        MarinadeUtils.solToLamports(amountSol)
    );

    const instructions = transaction.instructions;

    const latestBlockhash = await connection.getLatestBlockhash();

    // Compile transaction message
    const msg = new TransactionMessage({
        payerKey: from,
        recentBlockhash: latestBlockhash.blockhash,
        instructions,
    }).compileToLegacyMessage();

    const txMsg = new VersionedTransaction(msg);

    return {
        transaction: txMsg,
        rentFee: 0,
    };
}

/**
 * Deposits SOL to a specified stake pool
 * @param connection Solana connection
 * @param stakePoolAddress Pool address
 * @param from User's public key
 * @param amountSol Amount of SOL to stake
 * @returns Transaction and rent fee
 */
export async function depositSolToPool(
    connection: Connection,
    stakePoolAddress: PublicKey,
    from: PublicKey,
    amountSol: number
): Promise<{ transaction: VersionedTransaction; rentFee: number }> {
    const lamports = MarinadeUtils.solToLamports(amountSol);

    // Create deposit instructions
    const { instructions, signers } = await depositSol(
        connection,
        stakePoolAddress,
        from,
        lamports.toNumber()
    );

    const latestBlockhash = await connection.getLatestBlockhash();

    // Compile transaction message
    const msg = new TransactionMessage({
        payerKey: from,
        recentBlockhash: latestBlockhash.blockhash,
        instructions,
    }).compileToLegacyMessage();

    const transaction = new VersionedTransaction(msg);

    transaction.sign(signers);

    return {
        transaction,
        rentFee: 0,
    };
}

// Create example interactions for documentation and testing
export function createStakeExamples(config: StakeConfig): ActionExample[][] {
    const examples: ActionExample[][] = [];

    // Example with specific protocol
    examples.push([
        {
            user: "{{user1}}",
            content: {
                text: "Stake 2 SOL to Jito, my wallet address is: EugPwuZ8oUMWsYHeBGERWvELfLGFmA1taDtmY8uMeX6r",
                action: config.name,
            },
        },
        {
            user: "{{user2}}",
            content: {
                text: "Successfully constructed the transaction from stake 2SOL to Jito, with the transaction base58 encoded as 5KtPn3DXXzHkb7VAVHZGwXJQww39ASnrf7YkyJoF2qAGEpBEEGvRHHLnnTG8ZVwKqNHMqScWVGnsQAgfH5pbxEb",
                action: config.name,
            },
        },
    ]);

    // Example without specific protocol (auto-selection)
    examples.push([
        {
            user: "{{user1}}",
            content: {
                text: "Stake 3.5 SOL, my wallet address is: EugPwuZ8oUMWsYHeBGERWvELfLGFmA1taDtmY8uMeX6r",
                action: config.name,
            },
        },
        {
            user: "{{user2}}",
            content: {
                text: "The most suitable stake protocol blaze has been selected for you at present, and the base58 code for building the transaction is 5KtPn3DXXzHkb7VAVHZGwXJQww39ASnrf7YkyJoF2qAGEpBEEGvRHHLnnTG8ZVwKqNHMqScWVGnsQAgfH5pbxEb",
                action: config.name,
            },
        },
    ]);

    return examples;
}

// Template for creating stake parameters from user input
const createStakeTemplate = `Respond with a JSON markdown block containing only the extracted values. Use null for any values that cannot be determined.

Example response:
\\\`json
{
    "userAddress": "HqvTPqS2FaB2fQ7mxqZHQHz6H28o1u2Z9fRH5No8JN2W",
    "amountSol": "1.5",
    "poolName": ""
}
\\\`

{{recentMessages}}

Given the recent messages, extract or come up with (if not explicitly stated) the following information about the requested SOL staking:
- User Address for stake
- Amount of SOL to stake
- Pool name (either "jito" or "blaze" or "jpool" or "marinade" or "marginfi"). It may also be empty

Respond with a JSON markdown block containing only the extracted values.`;

// Template for selecting the best staking pool based on metrics
const selectionPoolTemplate = `Respond with a JSON markdown block containing only the extracted values. Use null for any values that cannot be determined.

Example response:
\\\`json
{
    "selectedPool": "jpool",
    "reason": ""
}
\\\`

Given the pool data:
{{poolData}}

Analyze the following factors to select the most suitable SOL staking protocol:
1. APY (Annual Percentage Yield) - Higher is better.
2. TVL (Total Value Locked) - Higher indicates more stability and liquidity.
3. Protocol reliability and features.

Select the best pool from these options: "jito", "blaze", "jpool", "marinade", or "marginfi".

State the reason for the selection.

Respond with a JSON markdown block containing only the extracted values.`;
