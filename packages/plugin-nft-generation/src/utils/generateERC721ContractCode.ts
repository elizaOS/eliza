import solc from "solc";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Load OpenZeppelin contract source code
export function loadOpenZeppelinFile(contractPath) {
    const __filename = fileURLToPath(import.meta.url); // get the resolved path to the file
    const __dirname = path.dirname(__filename); // get the name of the directory

    const fullPath = path.resolve(__dirname, '../../../', "node_modules", contractPath);
    return fs.readFileSync(fullPath, "utf8");
}

// Dynamic import callback for Solidity
export function importResolver(importPath) {
    if (importPath.startsWith("@openzeppelin/")) {
        return {
            contents: loadOpenZeppelinFile(importPath),
        };
    }
    return { error: "File not found" };
}

// Compile contract with custom import callback
export function compileWithImports(contractName, sourceCode) {
    const input = {
        language: "Solidity",
        sources: {
            [`${contractName}.sol`]: {
                content: sourceCode,
            },
        },
        settings: {
            outputSelection: {
                "*": {
                    "*": ["*"],
                },
            },
        },
    };

    const output = JSON.parse(
        solc.compile(JSON.stringify(input), { import: importResolver })
    );

    if (output.errors) {
        for (const err of output.errors) {
            console.error(err);
        }
    }
    const contractFile = output.contracts[`${contractName}.sol`][`${contractName}`];

    const metadata = JSON.parse(contractFile.metadata);
    return {
        abi: contractFile.abi,
        bytecode: contractFile.evm.bytecode.object,
        metadata
    };
}
