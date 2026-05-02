import { IdentifierKind, Signer } from "@xmtp/node-sdk";
import { getRandomValues } from "node:crypto";
import { fromString, toString } from "uint8arrays";
import { Hex, toBytes } from "viem";
import { privateKeyToAccount } from "viem/accounts";

export type SignerType = 'EOA' | 'SCW';

export const createEOASigner = (privateKey: Hex): Signer => {
    const account = privateKeyToAccount(privateKey);
    return {
        type: 'EOA',
        signMessage: async (message: string) => {
            const signature = await account.signMessage({
                message,
            });
            return toBytes(signature);
        },
        getIdentifier: async () => {
            return {
                identifierKind: IdentifierKind.Ethereum,
                identifier: account.address.toLowerCase(),
            }
        }
    }
}

export const createSCWSigner = (privateKey: Hex, chainId: bigint): Signer => {
    const account = privateKeyToAccount(privateKey);
    return {
        type: 'SCW',
        signMessage: async (message: string) => {
            const signature = await account.signMessage({
                message,
            });
            return toBytes(signature);
        },
        getIdentifier: async () => {
            return {
                identifierKind: IdentifierKind.Ethereum,
                identifier: account.address.toLowerCase(),
            }
        },
        getChainId() {
            return chainId;
        }
    }
}

export const generateEncryptionKeyHex = () => {
    const uint8Array = getRandomValues(new Uint8Array(32));
    return toString(uint8Array, "hex");
};

export const getEncryptionKeyFromHex = (hex: string) => {
    return fromString(hex, "hex");
};
