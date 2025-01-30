import axios from "axios";
import dotenv from "dotenv";
import * as fs from "node:fs";
import * as path from "node:path";
// import logger from './logger';

// Load environment variables from .env file
dotenv.config();

const ETHERSCAN_API_KEY =
    process.env.ETHERSCAN_API_KEY || "J9Q7QZ6A5TFNVIGSVIPPSHWKQVH8STVFUG";
const ETHERSCAN_API_URL =
    process.env.ETHERSCAN_API_URL || "https://api-sepolia.arbiscan.io/api";

async function getContractData(
    networkId: string,
    address: string,
    useCache = true
) {
    try {
        // Define output directory and file paths
        const outputDir = path.join(
            __dirname,
            "..",
            "..",
            "contracts",
            networkId,
            address
        );
        const abiFilePath = path.join(outputDir, "abi.json");
        const sourceFilePath = path.join(outputDir, "sourceCode.sol");

        // Check if cached data is acceptable and exists
        if (
            useCache &&
            fs.existsSync(abiFilePath) &&
            fs.existsSync(sourceFilePath)
        ) {
            const cachedAbi = JSON.parse(fs.readFileSync(abiFilePath, "utf-8"));
            const cachedSourceCode = fs.readFileSync(sourceFilePath, "utf-8");
            // logger.info(`Using cached ABI and source code from ${outputDir}`);
            return {
                abi: cachedAbi,
                sourceCode: cachedSourceCode,
            };
        }

        // Fetch ABI
        // logger.debug(`Fetching ABI for ${address} on ${networkId}`);
        const abiResponse = await axios.get(ETHERSCAN_API_URL, {
            params: {
                chainId: networkId,
                module: "contract",
                action: "getabi",
                address,
                apikey: ETHERSCAN_API_KEY,
            },
        });

        // Fetch source code
        // logger.debug(`Fetching source code for ${address} on ${networkId}`);
        const sourceResponse = await axios.get(ETHERSCAN_API_URL, {
            params: {
                chainId: networkId,
                module: "contract",
                action: "getsourcecode",
                address,
                apikey: ETHERSCAN_API_KEY,
            },
        });

        if (
            abiResponse.data.status !== "1" ||
            sourceResponse.data.status !== "1"
        ) {
            throw new Error("Failed to fetch contract data");
        }

        const abi = JSON.parse(abiResponse.data.result);
        const sourceCode = sourceResponse.data.result[0].SourceCode;

        // Ensure the directory exists
        fs.mkdirSync(outputDir, { recursive: true });

        // Write ABI to file
        fs.writeFileSync(abiFilePath, JSON.stringify(abi, null, 2));

        // Write source code to file
        fs.writeFileSync(sourceFilePath, sourceCode);

        // logger.info(`ABI and source code saved to ${outputDir}`);

        return {
            abi,
            sourceCode,
        };
    } catch (error) {
        // logger.error('Error fetching contract data:', error);
        console.error('Error fetching contract data:', error);
        throw new Error(`Failed to fetch contract data: ${error.message}`);
    }
}

export default getContractData;
