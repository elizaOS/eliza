import { describe, it, expect, beforeAll } from "vitest";
import {
    Account,
    generatePrivateKey,
    privateKeyToAccount,
} from "viem/accounts";
import { bsc, opBNB } from "viem/chains";

import { WalletProvider } from "../providers/wallet";

const customRpcUrls = {
    bsc: "custom-rpc.bsc.io",
    opBNB: "custom-rpc.opBNB.io",
};

describe("Wallet provider", () => {
    let pk: `0x${string}`;
    let account: Account;
    let walletProvider: WalletProvider;

    beforeAll(() => {
        pk = generatePrivateKey();
        account = privateKeyToAccount(pk);
        walletProvider = new WalletProvider(pk);
    });

    describe("Constructor", () => {
        it("get address", () => {
            const expectedAddress = account.address;

            expect(walletProvider.getAddress()).toEqual(expectedAddress);
        });
        it("get current chain", () => {
            expect(walletProvider.getCurrentChain().id).toEqual(bsc.id);
        });
        it("get chain configs", () => {
            expect(walletProvider.getChainConfigs("bsc").id).toEqual(bsc.id);
            expect(walletProvider.getChainConfigs("opBNB").id).toEqual(
                opBNB.id
            );
        });
    });
    describe("Clients", () => {
        it("generates public client", () => {
            const client = walletProvider.getPublicClient("bsc");
            expect(client.chain.id).toEqual(bsc.id);
            expect(client.transport.url).toEqual(bsc.rpcUrls.default.http[0]);
        });
        it("generates public client with custom rpcurl", () => {
            const chain = WalletProvider.genChainFromName(
                "bsc",
                customRpcUrls.bsc
            );
            const wp = new WalletProvider(pk, { ["bsc"]: chain });

            const client = wp.getPublicClient("bsc");
            expect(client.chain.id).toEqual(bsc.id);
            expect(client.chain.rpcUrls.default.http[0]).toEqual(
                bsc.rpcUrls.default.http[0]
            );
            expect(client.chain.rpcUrls.custom.http[0]).toEqual(
                customRpcUrls.bsc
            );
            expect(client.transport.url).toEqual(customRpcUrls.bsc);
        });
        it("generates wallet client", () => {
            const expectedAddress = account.address;

            const client = walletProvider.getWalletClient("bsc");

            expect(client.account?.address).toEqual(expectedAddress);
            expect(client.transport.url).toEqual(bsc.rpcUrls.default.http[0]);
        });
        it("generates wallet client with custom rpcurl", () => {
            const account = privateKeyToAccount(pk);
            const expectedAddress = account.address;
            const chain = WalletProvider.genChainFromName(
                "bsc",
                customRpcUrls.bsc
            );
            const wp = new WalletProvider(pk, { ["bsc"]: chain });

            const client = wp.getWalletClient("bsc");

            expect(client.account?.address).toEqual(expectedAddress);
            expect(client.chain?.id).toEqual(bsc.id);
            expect(client.chain?.rpcUrls.default.http[0]).toEqual(
                bsc.rpcUrls.default.http[0]
            );
            expect(client.chain?.rpcUrls.custom.http[0]).toEqual(
                customRpcUrls.bsc
            );
            expect(client.transport.url).toEqual(customRpcUrls.bsc);
        });
    });
});
