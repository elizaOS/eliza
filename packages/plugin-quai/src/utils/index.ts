import type { Content, IAgentRuntime } from "@elizaos/core";
import { JsonRpcProvider, Wallet } from "quais";

export const validateSettings = (runtime: IAgentRuntime) => {
    const requiredSettings = [
        "QUAI_PRIVATE_KEY",
        "QUAI_RPC_URL",
    ];

    for (const setting of requiredSettings) {
        if (!runtime.getSetting(setting)) {
            return false;
        }
    }

    return true;
};

export const getQuaiProvider = (runtime: IAgentRuntime) => {
    return new JsonRpcProvider(
        runtime.getSetting("QUAI_RPC_URL"),
    );
};

export const getQuaiAccount = (runtime: IAgentRuntime) => {
    const provider = getQuaiProvider(runtime);
    const account = new Wallet(runtime.getSetting("QUAI_PRIVATE_KEY"), provider);
    return account;
};

export interface TransferContent extends Content {
    tokenAddress: string;
    recipient: string;
    amount: string | number;
}

export function isTransferContent(
    content: unknown
): content is TransferContent {
    if (!content || typeof content !== 'object') {
        return false;
    }
    
    const contentObj = content as { tokenAddress?: unknown; recipient?: unknown; amount?: unknown };
    
    // Validate types
    const validTypes =
        (contentObj.tokenAddress === null || typeof contentObj.tokenAddress === "string") &&
        typeof contentObj.recipient === "string" &&
        (typeof contentObj.amount === "string" ||
            typeof contentObj.amount === "number");
    if (!validTypes) {
        return false;
    }

    // Validate addresses (20-bytes with 0x prefix)
    const recipient = contentObj.recipient as string;
    const tokenAddress = contentObj.tokenAddress as string | null;

    const validRecipient =
        recipient.startsWith("0x") &&
        recipient.length === 42;

    // If tokenAddress is provided, validate it
    const validTokenAddress = tokenAddress === null ||
        (tokenAddress.startsWith("0x") &&
        tokenAddress.length === 42);

    return validRecipient && validTokenAddress;
}

// export function isTransferContent(
//     content: any
// ): content is TransferContent {
//     // Validate types
//     const validTypes =
//         (content.tokenAddress === null || typeof content.tokenAddress === "string") &&
//         typeof content.recipient === "string" &&
//         (typeof content.amount === "string" ||
//             typeof content.amount === "number");
//     if (!validTypes) {
//         return false;
//     }

//     // Validate addresses (20-bytes with 0x prefix)
//     const validRecipient =
//         content.recipient.startsWith("0x") &&
//         content.recipient.length === 42;

//     // If tokenAddress is provided, validate it
//     const validTokenAddress = content.tokenAddress === null ||
//         (content.tokenAddress.startsWith("0x") &&
//         content.tokenAddress.length === 42);

//     return validRecipient && validTokenAddress;

