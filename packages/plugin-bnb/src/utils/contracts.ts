import { elizaLogger } from "@elizaos/core";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import solc from "solc";

const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const baseDir = path.resolve(__dirname, "../../plugin-bnb/src/contracts");

function getContractSource(contractPath: string) {
    return fs.readFileSync(contractPath, "utf8");
}

function findImports(importPath: string) {
    try {
        if (importPath.startsWith("@openzeppelin/")) {
            const modPath = require.resolve(importPath);
            return { contents: fs.readFileSync(modPath, "utf8") };
        }

        const localPath = path.resolve("./contracts", importPath);
        if (fs.existsSync(localPath)) {
            return { contents: fs.readFileSync(localPath, "utf8") };
        }
        return { error: "File not found" };
    } catch (e) {
        return { error: `File not found: ${importPath}` };
    }
}

export async function compileSolidity(contractFileName: string) {
    const contractPath = path.join(baseDir, contractFileName + ".sol");
    const source = getContractSource(contractPath);

    const input = {
        language: "Solidity",
        sources: {
            [contractFileName]: {
                content: source,
            },
        },
        settings: {
            optimizer: {
                enabled: true,
                runs: 200,
            },
            outputSelection: {
                "*": {
                    "*": ["*"],
                },
            },
        },
    };

    elizaLogger.debug("Compiling contract...");

    try {
        const output = JSON.parse(
            solc.compile(JSON.stringify(input), { import: findImports })
        );

        if (output.errors) {
            const hasError = output.errors.some(
                (error) => error.type === "Error"
            );
            if (hasError) {
                throw new Error(
                    `Compilation errors: ${JSON.stringify(output.errors, null, 2)}`
                );
            }
            elizaLogger.warn("Compilation warnings:", output.errors);
        }

        const contractName = path.basename(contractFileName, ".sol");
        const contract = output.contracts[contractFileName][contractName];

        if (!contract) {
            throw new Error("Contract compilation result is empty");
        }

        elizaLogger.debug("Contract compiled successfully");
        return {
            abi: contract.abi,
            bytecode: contract.evm.bytecode.object,
        };
    } catch (error) {
        elizaLogger.error("Compilation failed:", error.message);
        throw error;
    }
}
