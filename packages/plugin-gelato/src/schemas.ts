import { z } from "zod";

// Supported Chains Schema (Optional: Add your supported chains here if needed)
export const SupportedChainsSchema = z.enum([
    "mainnet",
    "sepolia",
    "goerli",
    "polygon",
    "arbitrum",
    "optimism",
    "arbitrumSepolia",
    // Add more supported chains as needed
]);

// Contract Interaction Schema
export const ContractInteractionSchema = z.object({
    abi: z.array(z.string()).describe("Human-readable ABI array"), // Array of strings representing the ABI
    functionName: z.string().describe("Function name to call"), // Name of the function
    args: z.array(z.any()).optional().describe("Arguments for the function"), // Optional array of arguments
    target: z
        .string()
        .regex(/^0x[a-fA-F0-9]{40}$/, "Invalid Ethereum address")
        .describe("Target contract address"), // Ethereum contract address
    chain: SupportedChainsSchema.describe("Blockchain identifier"), // Chain identifier
});

// Export the inferred TypeScript type
export type ContractInteractionInput = z.infer<
    typeof ContractInteractionSchema
>;
