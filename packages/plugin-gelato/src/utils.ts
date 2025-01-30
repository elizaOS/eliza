import {
    type SponsoredCallRequest,
    GelatoRelay,
    type CallWithERC2771Request,
} from "@gelatonetwork/relay-sdk-viem";
import { createPublicClient, encodeFunctionData } from "viem";
import type {
    PublicClient,
    Chain,
    Account,
    HttpTransport,
    WalletClient,
} from "viem";

const GELATO_RELAY_API_KEY = process.env.GELATO_RELAY_API_KEY || "";
const relay = new GelatoRelay();

/**
 * Executes a `sponsoredCall` with the Gelato Relay SDK.
 * @param client Public client to fetch chain information.
 * @param abi ABI of the contract.
 * @param functionName Function name to call.
 * @param args Arguments for the function call.
 * @param target Target contract address.
 */
export async function executeSponsoredCall(
    client: PublicClient<HttpTransport, Chain, Account | undefined>,
    abi: any,
    functionName: string,
    args: any[],
    target: string
) {
    try {
        // Get chain ID
        const chainId = await client.getChainId();

        // Encode function data
        const data = encodeFunctionData({
            abi,
            functionName,
            args,
        });

        // Prepare relay request
        const relayRequest: SponsoredCallRequest = {
            chainId: BigInt(chainId),
            target,
            data,
        };

        // Make the sponsored call
        const response = await relay.sponsoredCall(
            relayRequest,
            GELATO_RELAY_API_KEY
        );

        // Generate the task status URL
        const taskLink = `https://relay.gelato.digital/tasks/status/${response.taskId}`;
        console.log(`Task created successfully. Track here: ${taskLink}`);

        // Return response with task link
        return {
            ...response,
            taskLink,
        };
    } catch (error) {
        console.error("Error in executeSponsoredCall:", error);
        throw error;
    }
}

/**
 * Executes a `sponsoredCallERC2771` with the Gelato Relay SDK.
 * @param client Wallet client to sign user-specific transactions.
 * @param abi ABI of the contract.
 * @param functionName Function name to call.
 * @param args Arguments for the function call.
 * @param target Target contract address.
 * @param user Address of the user making the call.
 */
export async function executeSponsoredCallERC2771(
    client: WalletClient,
    abi: any,
    functionName: string,
    args: any[],
    target: string,
    user: `0x${string}`
) {
    try {
        // Get chain ID
        const chainId = await client.getChainId();

        // Encode function data
        const data = encodeFunctionData({
            abi,
            functionName,
            args,
        });

        // Prepare relay request
        const relayRequest: CallWithERC2771Request = {
            user,
            chainId: BigInt(chainId),
            target,
            data,
        };

        // Make the sponsored call
        const response = await relay.sponsoredCallERC2771(
            relayRequest,
            client,
            GELATO_RELAY_API_KEY
        );

        // Generate the task status URL
        const taskLink = `https://relay.gelato.digital/tasks/status/${response.taskId}`;
        console.log(`Task created successfully. Track here: ${taskLink}`);

        // Return response with task link
        return { ...response, taskLink };
    } catch (error) {
        console.error("Error in executeSponsoredCallERC2771:", error);
        throw error;
    }
}
