import type { IAgentRuntime } from "@elizaos/core";
import type { PrivateKeyAccount } from "viem/accounts";
import { privateKeyToAccount } from "viem/accounts";

export const useGetAccount = (runtime: IAgentRuntime): PrivateKeyAccount => {
	const PRIVATE_KEY = runtime.getSetting("ABSTRACT_PRIVATE_KEY");
	if (!PRIVATE_KEY) {
		throw new Error("ABSTRACT_PRIVATE_KEY is not set");
	}
	return privateKeyToAccount(`0x${PRIVATE_KEY}`);
};
