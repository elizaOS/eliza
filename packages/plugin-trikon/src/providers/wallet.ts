import { elizaLogger, type Provider } from "@elizaos/core";

function validateAddress(address: string | undefined): string {
    if (!address) {
        throw new Error('TRIKON_WALLET_ADDRESS environment variable is required');
    }
    if (!/^0x[a-fA-F0-9]{64}$/.test(address)) {
        throw new Error('Invalid wallet address format');
    }
    return address;
}

function validateBalance(balance: string | undefined): string {
    if (!balance) return "0";
    if (!/^\d+$/.test(balance)) {
        throw new Error('Invalid balance format');
    }
    return balance;
}

export interface WalletProvider {
    address: string;
    balance: string;
    getBalance(): Promise<string>;
    getAddress(): Promise<string>;
}

export const walletProvider: Provider = {
    get: async () => {
        elizaLogger.log("Getting Trikon wallet provider...");
        return {
            address: validateAddress(process.env.TRIKON_WALLET_ADDRESS),
            balance: validateBalance(process.env.TRIKON_INITIAL_BALANCE),
            getBalance: async () => validateBalance(process.env.TRIKON_INITIAL_BALANCE),
            getAddress: async () => validateAddress(process.env.TRIKON_WALLET_ADDRESS)
        };
    }
};

export default walletProvider;