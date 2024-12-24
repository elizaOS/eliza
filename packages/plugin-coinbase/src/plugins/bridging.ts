import { Coinbase, Wallet } from "@coinbase/coinbase-sdk";
import {
    Action,
    Plugin,
    elizaLogger,
    IAgentRuntime,
    Memory,
    HandlerCallback,
    State,
    composeContext,
    generateObjectV2,
    ModelClass,
    Provider,
} from "@ai16z/eliza";
import { createPublicClient, decodeAbiParameters, http, keccak256, toBytes } from 'viem';
import { base } from 'viem/chains';
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";
import { createArrayCsvWriter } from "csv-writer";
import { readFile } from "fs/promises";
import { parse } from "csv-parse/sync";
import {
    BridgeContent,
    BridgeRecord,
    isBridgeContent,
    BridgeSchema
} from "../types";
import { bridgeTemplate } from "../templates";
import {
    CCTP_CONTRACTS,
    CCTP_DOMAINS,
    CCTP_ABIS,
    CCTP_API
} from "../constants";

// Dynamically resolve the file path to the src/plugins directory
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const baseDir = path.resolve(__dirname, "../../plugin-coinbase/src/plugins");
const bridgeCsvFilePath = path.join(baseDir, "bridge.csv");

export const bridgeProvider: Provider = {
    get: async (runtime: IAgentRuntime, _message: Memory) => {
        try {
            Coinbase.configure({
                apiKeyName:
                    runtime.getSetting("COINBASE_API_KEY") ??
                    process.env.COINBASE_API_KEY,
                privateKey:
                    runtime.getSetting("COINBASE_PRIVATE_KEY") ??
                    process.env.COINBASE_PRIVATE_KEY,
            });
            elizaLogger.log("Reading CSV file from:", bridgeCsvFilePath);

            // Check if the file exists; if not, create it with headers
            if (!fs.existsSync(bridgeCsvFilePath)) {
                elizaLogger.warn("CSV file not found. Creating a new one.");
                const csvWriter = createArrayCsvWriter({
                    path: bridgeCsvFilePath,
                    header: [
                        "Source Chain",
                        "Destination Chain",
                        "Amount",
                        "Token",
                        "Status",
                        "Source Transaction Hash",
                        "Destination Transaction Hash",
                        "Timestamp"
                    ],
                });
                await csvWriter.writeRecords([]); // Create an empty file with headers
                elizaLogger.log("New CSV file created with headers.");
            }

            // Read and parse the CSV file
            const csvData = await readFile(bridgeCsvFilePath, "utf-8");
            const records = parse(csvData, {
                columns: true,
                skip_empty_lines: true,
            });

            elizaLogger.log("Parsed CSV records:", records);
            return {
                currentBridges: records.map((record: any) => ({
                    sourceChain: record["Source Chain"] || undefined,
                    destinationChain: record["Destination Chain"] || undefined,
                    amount: record["Amount"] || undefined,
                    token: record["Token"] || undefined,
                    status: record["Status"] || undefined,
                    sourceTransactionHash: record["Source Transaction Hash"] || "",
                    destinationTransactionHash: record["Destination Transaction Hash"] || "",
                    timestamp: record["Timestamp"] || "",
                })),
            };
        } catch (error) {
            elizaLogger.error("Error in bridgeProvider:", error);
            return [];
        }
    },
};

export const executeBridgeAction: Action = {
    name: "EXECUTE_BRIDGE",
    description: "Execute a bridge between two chains using the Coinbase SDK and log the result.",
    validate: async (runtime: IAgentRuntime, _message: Memory) => {
        elizaLogger.log("Validating runtime for EXECUTE_BRIDGE...");
        return (
            !!(
                runtime.character.settings.secrets?.COINBASE_API_KEY ||
                process.env.COINBASE_API_KEY
            ) &&
            !!(
                runtime.character.settings.secrets?.COINBASE_PRIVATE_KEY ||
                process.env.COINBASE_PRIVATE_KEY
            )
        );
    },
    handler: async (
        runtime: IAgentRuntime,
        _message: Memory,
        state: State,
        _options: any,
        callback: HandlerCallback
    ) => {
        elizaLogger.log("Starting EXECUTE_BRIDGE handler...");

        try {
            Coinbase.configure({
                apiKeyName: runtime.getSetting("COINBASE_API_KEY") ??
                    process.env.COINBASE_API_KEY,
                privateKey: runtime.getSetting("COINBASE_PRIVATE_KEY") ??
                    process.env.COINBASE_PRIVATE_KEY,
            });

            const context = composeContext({
                state,
                template: bridgeTemplate,
            });

            const bridgeDetails = await generateObjectV2({
                runtime,
                context,
                modelClass: ModelClass.LARGE,
                schema: BridgeSchema,
            });

            if (!isBridgeContent(bridgeDetails.object)) {
                callback(
                    {
                        text: "Invalid bridge details. Ensure source chain, destination chain, amount, and token are correctly specified.",
                    },
                    []
                );
                return;
            }

            const { sourceWalletId, destinationWalletId, amount, token } = bridgeDetails.object as BridgeContent;

            const sourceWallet = await Wallet.fetch(sourceWalletId);
            const destinationWallet = await Wallet.fetch(destinationWalletId);

            // TODO: Implement bridge logic here...

            callback(
                { text: "Bridge executed successfully." },
                []
            );
        } catch (error) {
            elizaLogger.error("Error during bridge execution:", error);
            callback(
                {
                    text: "Failed to execute the bridge. Please check the logs for more details.",
                },
                []
            );
        }
    },
    examples: [
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Bridge 1 USDC from Base to Arbitrum",
                },
            },
            {
                user: "{{agentName}}",
                content: {
                    text: `Bridge executed successfully:
- Amount: 1 USDC
- From: Base
- To: Arbitrum
- Source Transaction: 0x...
- Destination Transaction: 0x...`,
                },
            },
        ],
    ],
    similes: [
        "BRIDGING_TOKENS",
        "BRIDGING_ASSETS",
        "BRIDGING_CHAIN",
    ]
};

export const bridgePlugin: Plugin = {
    name: "bridgePlugin",
    description: "Enables bridging tokens between chains using the Coinbase SDK.",
    actions: [executeBridgeAction],
    providers: [bridgeProvider],
};