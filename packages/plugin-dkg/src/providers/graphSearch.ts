import dotenv from "dotenv";
dotenv.config();
import {
    IAgentRuntime,
    Memory,
    Provider,
    State,
    elizaLogger,
    ModelClass,
    generateObject,
} from "@elizaos/core";
import {
    combinedSparqlExample,
    dkgMemoryTemplate,
    generalSparqlQuery,
} from "../constants.ts";
// @ts-ignore
import DKG from "dkg.js";
import { DKGSelectQuerySchema, isDKGSelectQuery } from "../types.ts";

// Provider configuration
const PROVIDER_CONFIG = {
    environment: process.env.DKG_ENVIRONMENT || "testnet",
    endpoint: process.env.DKG_HOSTNAME || "http://default-endpoint",
    port: process.env.DKG_PORT || "8900",
    blockchain: {
        name: process.env.DKG_BLOCKCHAIN_NAME || "base:84532",
        publicKey: process.env.DKG_PUBLIC_KEY || "",
        privateKey: process.env.DKG_PRIVATE_KEY || "",
    },
    maxNumberOfRetries: 300,
    frequency: 2,
    contentType: "all",
    nodeApiVersion: "/v1",
};

interface BlockchainConfig {
    name: string;
    publicKey: string;
    privateKey: string;
}

interface DKGClientConfig {
    environment: string;
    endpoint: string;
    port: string;
    blockchain: BlockchainConfig;
    maxNumberOfRetries?: number;
    frequency?: number;
    contentType?: string;
    nodeApiVersion?: string;
}

async function constructSparqlQuery(
    runtime: IAgentRuntime,
    userQuery: string
): Promise<string> {
    const context = `
    You are tasked with generating a SPARQL query to retrieve information from a Decentralized Knowledge Graph (DKG).
    The query should align with the JSON-LD memory template provided below:

    ${JSON.stringify(dkgMemoryTemplate)}

    ** Examples **
    Use the following SPARQL example to understand the format:
    ${combinedSparqlExample}

    ** Instructions **
    1. Analyze the user query and identify the key fields and concepts it refers to.
    2. Use these fields and concepts to construct a SPARQL query.
    3. Ensure the SPARQL query follows standard syntax and can be executed against the DKG.
    4. Use 'OR' logic when constructing the query to ensure broader matching results. For example, if multiple keywords or concepts are provided, the query should match any of them, not all.
    5. Replace the examples with actual terms from the user's query.
    6. Always select distinct results by adding the DISTINCT keyword.
    7. Always select headline and article body. Do not select other fields.

    ** User Query **
    ${userQuery}

    ** Output **
    Provide only the SPARQL query, wrapped in a sparql code block for clarity.
  `;

    const sparqlQueryResult = await generateObject({
        runtime,
        context,
        modelClass: ModelClass.LARGE,
        schema: DKGSelectQuerySchema,
    });

    if (!isDKGSelectQuery(sparqlQueryResult.object)) {
        elizaLogger.error("Invalid SELECT SPARQL query generated.");
        throw new Error("Invalid SELECT SPARQL query generated.");
    }

    return sparqlQueryResult.object.query;
}

export class DKGProvider {
    private client: any; // TODO: add type
    constructor(config: DKGClientConfig) {
        this.validateConfig(config);
    }

    private validateConfig(config: DKGClientConfig): void {
        const requiredStringFields = ["environment", "endpoint", "port"];

        for (const field of requiredStringFields) {
            if (typeof config[field as keyof DKGClientConfig] !== "string") {
                elizaLogger.error(
                    `Invalid configuration: Missing or invalid value for '${field}'`
                );
                throw new Error(
                    `Invalid configuration: Missing or invalid value for '${field}'`
                );
            }
        }

        if (!config.blockchain || typeof config.blockchain !== "object") {
            elizaLogger.error(
                "Invalid configuration: 'blockchain' must be an object"
            );
            throw new Error(
                "Invalid configuration: 'blockchain' must be an object"
            );
        }

        const blockchainFields = ["name", "publicKey", "privateKey"];

        for (const field of blockchainFields) {
            if (
                typeof config.blockchain[field as keyof BlockchainConfig] !==
                "string"
            ) {
                elizaLogger.error(
                    `Invalid configuration: Missing or invalid value for 'blockchain.${field}'`
                );
                throw new Error(
                    `Invalid configuration: Missing or invalid value for 'blockchain.${field}'`
                );
            }
        }

        this.client = new DKG(config);
    }

    async search(runtime: IAgentRuntime, message: Memory): Promise<string> {
        elizaLogger.info(`Entering graph search provider!`);

        const userQuery = message.content.text;

        elizaLogger.info(`Got user query ${JSON.stringify(userQuery)}`);

        const query = await constructSparqlQuery(runtime, userQuery);
        elizaLogger.info(`Generated SPARQL query: ${query}`);

        let queryOperationResult = await this.client.graph.query(
            query,
            "SELECT"
        );

        if (!queryOperationResult || !queryOperationResult.data?.length) {
            elizaLogger.info(
                `LLM-generated SPARQL query failed, defaulting to basic query.`
            );

            queryOperationResult = await this.client.graph.query(
                generalSparqlQuery,
                "SELECT"
            );
        }

        elizaLogger.info(
            `Got ${queryOperationResult.data.length} results from the DKG`
        );

        // TODO: take 5 results instead of all based on similarity in the future
        const result = queryOperationResult.data.map((entry: any) => {
            const formattedParts = Object.keys(entry).map(
                (key) => `${key}: ${entry[key]}`
            );
            return formattedParts.join(", ");
        });

        return result.join("\n");
    }
}

export const graphSearch: Provider = {
    get: async (
        runtime: IAgentRuntime,
        _message: Memory,
        _state?: State
    ): Promise<string | null> => {
        try {
            const provider = new DKGProvider(PROVIDER_CONFIG);

            return await provider.search(runtime, _message);
        } catch (error) {
            elizaLogger.error("Error in wallet provider:", error);
            return null;
        }
    },
};
