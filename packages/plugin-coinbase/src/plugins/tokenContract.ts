import { Coinbase, readContract, type SmartContract } from "@coinbase/coinbase-sdk";
import {
    type Action,
    type Plugin,
    elizaLogger,
    type IAgentRuntime,
    type Memory,
    type HandlerCallback,
    type State,
    composeContext,
    generateObject,
    ModelClass,
} from "@elizaos/core";
import { initializeWallet } from "../utils";
import {
    contractInvocationTemplate,
    tokenContractTemplate,
    readContractTemplate,
} from "../templates";
import {
    ContractInvocationSchema,
    TokenContractSchema,
    isContractInvocationContent,
    isTokenContractContent,
    ReadContractSchema,
    isReadContractContent,
} from "../types";
import path from "path";
import { fileURLToPath } from "url";
import { createArrayCsvWriter } from "csv-writer";
import fs from "fs";
import { ABI } from "../constants";

// Dynamically resolve the file path to the src/plugins directory
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const baseDir = path.resolve(__dirname, "../../plugin-coinbase/src/plugins");
const contractsCsvFilePath = path.join(baseDir, "contracts.csv");

// Add this helper at the top level
const serializeBigInt = (value: any): any => {
    if (typeof value === "bigint") {
        return value.toString();
    }
    if (Array.isArray(value)) {
        return value.map(serializeBigInt);
    }
    if (typeof value === "object" && value !== null) {
        return Object.fromEntries(
            Object.entries(value).map(([k, v]) => [k, serializeBigInt(v)])
        );
    }
    return value;
};

export const deployTokenContractAction: Action = {
    name: "DEPLOY_TOKEN_CONTRACT",
    description:
        "Deploy an ERC20, ERC721, or ERC1155 token contract using the Coinbase SDK",
    validate: async (runtime: IAgentRuntime, _message: Memory) => {
        elizaLogger.info("Validating runtime for DEPLOY_TOKEN_CONTRACT...");
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
        elizaLogger.debug("Starting DEPLOY_TOKEN_CONTRACT handler...");

        try {
            Coinbase.configure({
                apiKeyName:
                    runtime.getSetting("COINBASE_API_KEY") ??
                    process.env.COINBASE_API_KEY,
                privateKey:
                    runtime.getSetting("COINBASE_PRIVATE_KEY") ??
                    process.env.COINBASE_PRIVATE_KEY,
            });

            // Ensure CSV file exists
            if (!fs.existsSync(contractsCsvFilePath)) {
                const csvWriter = createArrayCsvWriter({
                    path: contractsCsvFilePath,
                    header: [
                        "Contract Type",
                        "Name",
                        "Symbol",
                        "Network",
                        "Contract Address",
                        "Transaction URL",
                        "Base URI",
                        "Total Supply",
                    ],
                });
                await csvWriter.writeRecords([]);
            }

            const context = composeContext({
                state,
                template: tokenContractTemplate,
            });

            const contractDetails = await generateObject({
                runtime,
                context,
                modelClass: ModelClass.SMALL,
                schema: TokenContractSchema,
            });
            elizaLogger.info("Contract details:", contractDetails.object);

            if (!isTokenContractContent(contractDetails.object)) {
                callback(
                    {
                        text: "Invalid contract details. Please check the inputs.",
                    },
                    []
                );
                return;
            }

            const {
                contractType,
                name,
                symbol,
                network,
                baseURI,
                totalSupply,
            } = contractDetails.object;
            elizaLogger.info("Contract details:", contractDetails.object);
            const wallet = await initializeWallet(runtime, network);
            let contract: SmartContract;
            let deploymentDetails;

            switch (contractType.toLowerCase()) {
                case "erc20":
                    contract = await wallet.deployToken({
                        name,
                        symbol,
                        totalSupply: totalSupply || 1000000,
                    });
                    deploymentDetails = {
                        contractType: "ERC20",
                        totalSupply,
                        baseURI: "N/A",
                    };
                    break;

                case "erc721":
                    contract = await wallet.deployNFT({
                        name,
                        symbol,
                        baseURI: baseURI || "",
                    });
                    deploymentDetails = {
                        contractType: "ERC721",
                        totalSupply: "N/A",
                        baseURI,
                    };
                    break;
                default:
                    throw new Error(
                        `Unsupported contract type: ${contractType}`
                    );
            }

            // Wait for deployment to complete
            await contract.wait();
            elizaLogger.info("Deployment details:", deploymentDetails);
            elizaLogger.info("Contract deployed successfully:", contract);
            // Log deployment to CSV
            const csvWriter = createArrayCsvWriter({
                path: contractsCsvFilePath,
                header: [
                    "Contract Type",
                    "Name",
                    "Symbol",
                    "Network",
                    "Contract Address",
                    "Transaction URL",
                    "Base URI",
                    "Total Supply",
                ],
                append: true,
            });
            const transaction =
                contract.getTransaction()?.getTransactionLink() || "";
            const contractAddress = contract.getContractAddress();
            await csvWriter.writeRecords([
                [
                    deploymentDetails.contractType,
                    name,
                    symbol,
                    network,
                    contractAddress,
                    transaction,
                    deploymentDetails.baseURI,
                    deploymentDetails.totalSupply || "",
                ],
            ]);

            callback(
                {
                    text: `Token contract deployed successfully:
- Type: ${deploymentDetails.contractType}
- Name: ${name}
- Symbol: ${symbol}
- Network: ${network}
- Contract Address: ${contractAddress}
- Transaction URL: ${transaction}
${deploymentDetails.baseURI !== "N/A" ? `- Base URI: ${deploymentDetails.baseURI}` : ""}
${deploymentDetails.totalSupply !== "N/A" ? `- Total Supply: ${deploymentDetails.totalSupply}` : ""}

Contract deployment has been logged to the CSV file.`,
                },
                []
            );
        } catch (error) {
            elizaLogger.error("Error deploying token contract:", error);
            callback(
                {
                    text: "Failed to deploy token contract. Please check the logs for more details.",
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
                    text: "Deploy an ERC721 token named 'MyNFT' with symbol 'MNFT' on base network with URI 'https://pbs.twimg.com/profile_images/1848823420336934913/oI0-xNGe_400x400.jpg'",
                },
            },
            {
                user: "{{agentName}}",
                content: {
                    text: `Token contract deployed successfully:
- Type: ERC20
- Name: MyToken
- Symbol: MTK
- Network: base
- Contract Address: 0x...
- Transaction URL: https://basescan.org/tx/...
- Total Supply: 1000000`,
                },
            },
            {
                user: "{{user1}}",
                content: {
                    text: "Deploy an ERC721 token named 'MyNFT' with symbol 'MNFT' on the base network",
                },
            },
            {
                user: "{{agentName}}",
                content: {
                    text: `Token contract deployed successfully:
- Type: ERC721
- Name: MyNFT
- Symbol: MNFT
- Network: base
- Contract Address: 0x...
- Transaction URL: https://basescan.org/tx/...
- URI: https://pbs.twimg.com/profile_images/1848823420336934913/oI0-xNGe_400x400.jpg`,
                },
            },
        ],
    ],
    similes: ["DEPLOY_CONTRACT", "CREATE_TOKEN", "MINT_TOKEN", "CREATE_NFT"],
};

// Add to tokenContract.ts
export const invokeContractAction: Action = {
    name: "INVOKE_CONTRACT",
    description:
        "Invoke a method on a deployed smart contract using the Coinbase SDK",
    validate: async (runtime: IAgentRuntime, _message: Memory) => {
        elizaLogger.info("Validating runtime for INVOKE_CONTRACT...");
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
        elizaLogger.debug("Starting INVOKE_CONTRACT handler...");

        try {
            Coinbase.configure({
                apiKeyName:
                    runtime.getSetting("COINBASE_API_KEY") ??
                    process.env.COINBASE_API_KEY,
                privateKey:
                    runtime.getSetting("COINBASE_PRIVATE_KEY") ??
                    process.env.COINBASE_PRIVATE_KEY,
            });

            const context = composeContext({
                state,
                template: contractInvocationTemplate,
            });

            const invocationDetails = await generateObject({
                runtime,
                context,
                modelClass: ModelClass.LARGE,
                schema: ContractInvocationSchema,
            });
            elizaLogger.info("Invocation details:", invocationDetails.object);
            if (!isContractInvocationContent(invocationDetails.object)) {
                callback(
                    {
                        text: "Invalid contract invocation details. Please check the inputs.",
                    },
                    []
                );
                return;
            }

            const {
                contractAddress,
                method,
                args,
                amount,
                assetId,
                networkId,
            } = invocationDetails.object;
            const wallet = await initializeWallet(runtime, networkId);

            // Prepare invocation options
            const invocationOptions = {
                contractAddress,
                method,
                abi: ABI,
                args: {
                    ...args,
                    amount: args.amount || amount, // Ensure amount is passed in args
                },
                networkId,
                assetId,
            };
            elizaLogger.info("Invocation options:", invocationOptions);
            // Invoke the contract
            const invocation = await wallet.invokeContract(invocationOptions);

            // Wait for the transaction to be mined
            await invocation.wait();

            // Log the invocation to CSV
            const csvWriter = createArrayCsvWriter({
                path: contractsCsvFilePath,
                header: [
                    "Contract Address",
                    "Method",
                    "Network",
                    "Status",
                    "Transaction URL",
                    "Amount",
                    "Asset ID",
                ],
                append: true,
            });

            await csvWriter.writeRecords([
                [
                    contractAddress,
                    method,
                    networkId,
                    invocation.getStatus(),
                    invocation.getTransactionLink() || "",
                    amount || "",
                    assetId || "",
                ],
            ]);

            callback(
                {
                    text: `Contract method invoked successfully:
- Contract Address: ${contractAddress}
- Method: ${method}
- Network: ${networkId}
- Status: ${invocation.getStatus()}
- Transaction URL: ${invocation.getTransactionLink() || "N/A"}
${amount ? `- Amount: ${amount}` : ""}
${assetId ? `- Asset ID: ${assetId}` : ""}

Contract invocation has been logged to the CSV file.`,
                },
                []
            );
        } catch (error) {
            elizaLogger.error("Error invoking contract method:", error);
            callback(
                {
                    text: "Failed to invoke contract method. Please check the logs for more details.",
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
                    text: "Call the 'transfer' method on my ERC20 token contract at 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48 with amount 100 to recipient 0xbcF7C64B880FA89a015970dC104E848d485f99A3",
                },
            },
            {
                user: "{{agentName}}",
                content: {
                    text: `Contract method invoked successfully:
- Contract Address: 0x123...
- Method: transfer
- Network: base
- Status: SUCCESS
- Transaction URL: https://basescan.org/tx/...
- Amount: 100
- Asset ID: wei

Contract invocation has been logged to the CSV file.`,
                },
            },
        ],
    ],
    similes: ["CALL_CONTRACT", "EXECUTE_CONTRACT", "INTERACT_WITH_CONTRACT"],
};

export const readContractAction: Action = {
    name: "READ_CONTRACT",
    description:
        "Read data from a deployed smart contract using the Coinbase SDK",
    validate: async (runtime: IAgentRuntime, _message: Memory) => {
        elizaLogger.info("Validating runtime for READ_CONTRACT...");
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
        elizaLogger.debug("Starting READ_CONTRACT handler...");

        try {
            Coinbase.configure({
                apiKeyName:
                    runtime.getSetting("COINBASE_API_KEY") ??
                    process.env.COINBASE_API_KEY,
                privateKey:
                    runtime.getSetting("COINBASE_PRIVATE_KEY") ??
                    process.env.COINBASE_PRIVATE_KEY,
            });

            const context = composeContext({
                state,
                template: readContractTemplate,
            });

            const readDetails = await generateObject({
                runtime,
                context,
                modelClass: ModelClass.SMALL,
                schema: ReadContractSchema,
            });

            if (!isReadContractContent(readDetails.object)) {
                callback(
                    {
                        text: "Invalid contract read details. Please check the inputs.",
                    },
                    []
                );
                return;
            }

            const { contractAddress, method, args, networkId, abi } =
                readDetails.object;
            elizaLogger.info("Reading contract:", {
                contractAddress,
                method,
                args,
                networkId,
                abi,
            });

            const result = await readContract({
                networkId,
                contractAddress,
                method,
                args,
                abi: ABI as any,
            });

            // Serialize the result before using it
            const serializedResult = serializeBigInt(result);

            elizaLogger.info("Contract read result:", serializedResult);

            callback(
                {
                    text: `Contract read successful:
- Contract Address: ${contractAddress}
- Method: ${method}
- Network: ${networkId}
- Result: ${JSON.stringify(serializedResult, null, 2)}`,
                },
                []
            );
        } catch (error) {
            elizaLogger.error("Error reading contract:", error);
            callback(
                {
                    text: `Failed to read contract: ${error instanceof Error ? error.message : "Unknown error"}`,
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
                    text: "Read the balance of address 0xbcF7C64B880FA89a015970dC104E848d485f99A3 from the ERC20 contract at 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48 on eth",
                },
            },
            {
                user: "{{agentName}}",
                content: {
                    text: `Contract read successful:
- Contract Address: 0x37f2131ebbc8f97717edc3456879ef56b9f4b97b
- Method: balanceOf
- Network: eth
- Result: "1000000"`,
                },
            },
        ],
    ],
    similes: ["READ_CONTRACT", "GET_CONTRACT_DATA", "QUERY_CONTRACT"],
};

export const tokenContractPlugin: Plugin = {
    name: "tokenContract",
    description:
        "Enables deployment, invocation, and reading of ERC20, ERC721, and ERC1155 token contracts using the Coinbase SDK",
    actions: [
        deployTokenContractAction,
        invokeContractAction,
        readContractAction,
    ],
};
