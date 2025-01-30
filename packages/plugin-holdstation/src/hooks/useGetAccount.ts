import { IAgentRuntime } from "@elizaos/core";
import type { PrivateKeyAccount } from "viem/accounts";
import { privateKeyToAccount } from "viem/accounts";

export const useGetAccount = (runtime: IAgentRuntime): PrivateKeyAccount => {
    const privateKey = runtime.getSetting("HOLDSTATION_PRIVATE_KEY");
    if (!privateKey) {
        throw new Error("HOLDSTATION_PRIVATE_KEY not found in settings");
    }
    return privateKeyToAccount(`0x${privateKey}`);
};
