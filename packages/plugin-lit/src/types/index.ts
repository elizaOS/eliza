import { LitNodeClient } from "@lit-protocol/lit-node-client";
import { PKPEthersWallet } from "@lit-protocol/pkp-ethers";

export interface PKPWallet {
    ethWallet: PKPEthersWallet;
    // solWallet?: any; // TODO: Add Solana wallet type
    tokenId: string;
    publicKey: string;
    ethAddress: string;
}

export interface LitConfig {
    network: "cayenne" | "datilDev" | "datilTest" | "datil";
    debug?: boolean;
    minNodeCount?: number;
}

export interface AuthMethod {
    authMethodType: number;
    accessToken: string;
}

export interface AuthSig {
    sig: string;
    derivedVia: string;
    signedMessage: string;
    address: string;
}

export interface SessionSigs {
    [key: string]: AuthSig;
}

export interface LitClientContext {
    litNodeClient: LitNodeClient;
    sessionSigs?: SessionSigs;
    chain: "ethereum" | "solana";
}

export interface PKPWalletResponse {
    publicKey: string;
    ethAddress: string;
}
