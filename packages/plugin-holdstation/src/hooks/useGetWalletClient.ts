import { createWalletClient, http } from "viem";
import { zksync } from "viem/chains";
import { eip712WalletActions } from "viem/zksync";

export const useGetWalletClient = (): ReturnType<typeof createWalletClient> => {
    const client = createWalletClient({
        chain: zksync,
        transport: http(),
    }).extend(eip712WalletActions());

    return client;
};
