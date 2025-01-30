import { DirectSecp256k1HdWallet } from '@cosmjs/proto-signing';
import { SigningStargateClient, Coin } from '@cosmjs/stargate';

export interface Pattern {
    regex: RegExp;
    responses: string[];
}

export interface WalletConnection {
    wallet: DirectSecp256k1HdWallet;
    client: SigningStargateClient;
}

export interface Fee {
    amount: Coin[];
    gas: string;
}