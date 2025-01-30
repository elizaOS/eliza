import { IAgentRuntime, Memory, State } from "@elizaos/core";
import { AUTH_METHOD_SCOPE } from "@lit-protocol/constants";
import { BigNumber, utils } from "ethers";
import { LitContracts } from "@lit-protocol/contracts-sdk";
import { LitNodeClient } from "@lit-protocol/lit-node-client";

interface LitState {
  contractClient: LitContracts;
  nodeClient: LitNodeClient;
  authSig: {
    sig: string;
    derivedVia: string;
    signedMessage: string;
    address: string;
  };
}

export const pkpPermissionsProvider = {
  addPermissions: async (
    _runtime: IAgentRuntime,
    _message: Memory,
    state: State,
    tokenId: string,
    authMethod: {
      authMethodType: number;
      id: string;
      userPubkey: string;
    },
    scopes: (typeof AUTH_METHOD_SCOPE)[]
  ) => {
    const { contractClient } = (state.lit || {}) as LitState;
    if (!contractClient) {
      throw new Error("Lit contracts client not available");
    }

    const tx =
      await contractClient.pkpPermissionsContract.write.addPermittedAuthMethod(
        tokenId,
        authMethod,
        scopes.map((s) => BigNumber.from(s)),
        { gasPrice: utils.parseUnits("1", "gwei"), gasLimit: 400000 }
      );
    await tx.wait();
    return `Permissions added to PKP ${tokenId}`;
  },
};
