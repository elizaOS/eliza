import { describe, it, expect, beforeEach } from "vitest";
import { MplBubblegumProvider } from "../providers/bubblegumProvider";
import { Keypair } from "@solana/web3.js";
import { fromWeb3JsKeypair } from "@metaplex-foundation/umi-web3js-adapters";

describe("WalletProvider", () => {
    let walletProvider: MplBubblegumProvider;

    beforeEach(() => {
        const keypair = Keypair.generate();
        const RPC_URL = "https://api.devnet.solana.com";
        walletProvider = new MplBubblegumProvider(
            fromWeb3JsKeypair(keypair),
            RPC_URL
        );
    });

    it("should retrieve the wallet address", () => {
        const address = walletProvider.getKeypairPubKey();
        expect(address).toBeDefined();
    });
});
