import { TransactionResponse } from "ethers";
import { Contract, JsonRpcProvider, Wallet } from "ethers";

export namespace Chain {
    export enum Testnet {
        AUTOMATA = "automata_testnet",
    }

    export enum Mainnet {}

    export const Config: Record<Chain, { rpcUrl: string; address: string }> = {
        [Testnet.AUTOMATA]: {
            rpcUrl: "https://1rpc.io/ata/testnet",
            address: "0x6D67Ae70d99A4CcE500De44628BCB4DaCfc1A145",
        },
    };
}
export type Chain = Chain.Testnet | Chain.Mainnet;

export async function verifyAndAttestOnChain(
    privateKey: string,
    rawQuote: string,
    chain: Chain = Chain.Testnet.AUTOMATA
) {
    const { rpcUrl, address } = Chain.Config[chain];
    const provider = new JsonRpcProvider(rpcUrl);
    const wallet = new Wallet(privateKey, provider);
    const contract = new Contract(
        address,
        [
            "function getBp() public view returns (uint16)",
            "function verifyAndAttestOnChain(bytes calldata rawQuote) external payable returns (bool success, bytes memory output)",
        ],
        wallet
    );
    const estimateGas = async (value: bigint) =>
        await contract.verifyAndAttestOnChain.estimateGas(rawQuote, { value });

    const $bp = contract.getBp();
    const $fee = provider.getFeeData();
    const gas = await estimateGas(await provider.getBalance(wallet));
    const bp = await $bp;
    const { gasPrice, maxFeePerGas } = await $fee;
    const tx = await contract.verifyAndAttestOnChain(rawQuote, {
        value: (gas * (gasPrice || maxFeePerGas)! * bp * 105n) / 1000000n,
    });
    return await (tx as TransactionResponse).wait();
}
