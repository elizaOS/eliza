import { JettonMaster } from "@ton/ton";

export type Token = {
    address: string;
    name: string;
};

export interface DEX {
    createPool: (params: { isTon: boolean; jettons: JettonMaster[] }) => {};
    // LP tokens should be issued
    deposit: (params: {
        jettonDeposits: JettonDeposit[];
        isTon: boolean;
        tonAmount: number;
    }) => {};
    // LP tokens should be burned
    withdraw: (params: {
        jettonWithdrawals: JettonWithdrawal[];
        isTon: boolean;
        amount: number;
    }) => {};
    claimFee: (params: { isTon: boolean; jettons: JettonMaster[] }) => {};
}

export type JettonDeposit = {
    jetton: JettonMaster;
    amount: number;
};

export type JettonWithdrawal = JettonDeposit;

export type TransactionHash = string;
