import {
  fetchToolPolicyFromRegistry,
  getPkpInfo,
  getPkpToolRegistryContract,
  NETWORK_CONFIG,
} from '@lit-protocol/aw-tool';

import { getTokenInfo } from './utils/get-erc20-info';
import { getGasData } from './utils/get-gas-data';
import { estimateGasLimit } from './utils/estimate-gas-limit';
import { createAndSignTransaction } from './utils/create-and-sign-tx';
import { broadcastTransaction } from './utils/broadcast-tx';

declare global {
  // Required Inputs
  const params: {
    pkpEthAddress: string;
    rpcUrl: string;
    chainId: string;
    tokenIn: string;
    recipientAddress: string;
    amountIn: string;
  };
}

(async () => {
  try {
    console.log(`Using Lit Network: ${LIT_NETWORK}`);
    console.log(
      `Using PKP Tool Registry Address: ${PKP_TOOL_REGISTRY_ADDRESS}`
    );
    console.log(
      `Using Pubkey Router Address: ${
        NETWORK_CONFIG[LIT_NETWORK as keyof typeof NETWORK_CONFIG]
          .pubkeyRouterAddress
      }`
    );

    const delegateeAddress = ethers.utils.getAddress(LitAuth.authSigAddress);
    const toolIpfsCid = LitAuth.actionIpfsIds[0];
    const provider = new ethers.providers.JsonRpcProvider(params.rpcUrl);
    const pkpToolRegistryContract = await getPkpToolRegistryContract(
      PKP_TOOL_REGISTRY_ADDRESS
    );
    const pkp = await getPkpInfo(params.pkpEthAddress);
    const tokenInfo = await getTokenInfo(
      provider,
      params.tokenIn,
      pkp.ethAddress
    );

    console.log(`Token info: ${JSON.stringify(tokenInfo)}`);

    const toolPolicy = await fetchToolPolicyFromRegistry(
      pkpToolRegistryContract,
      pkp.tokenId,
      delegateeAddress,
      toolIpfsCid
    );
    if (
      toolPolicy.enabled &&
      toolPolicy.policyIpfsCid !== undefined &&
      toolPolicy.policyIpfsCid !== '0x' &&
      toolPolicy.policyIpfsCid !== ''
    ) {
      console.log(`Executing policy ${toolPolicy.policyIpfsCid}`);

      const policyParams = {
        parentToolIpfsCid: toolIpfsCid,
        pkpToolRegistryContractAddress: PKP_TOOL_REGISTRY_ADDRESS,
        pkpTokenId: pkp.tokenId,
        delegateeAddress,
        tokenInfo: {
          amount: tokenInfo.amount.toString(),
          tokenAddress: params.tokenIn,
          recipientAddress: params.recipientAddress,
        },
      };

      console.log(
        `Calling policy Lit Action with params: ${JSON.stringify(policyParams)}`
      );

      await Lit.Actions.call({
        ipfsId: toolPolicy.policyIpfsCid,
        params: policyParams,
      });
    } else {
      console.log(
        `No policy found for tool ${toolIpfsCid} on PKP ${pkp.tokenId} for delegatee ${delegateeAddress}`
      );
    }

    const gasData = await getGasData(provider, pkp.ethAddress);
    const gasLimit = await estimateGasLimit(
      provider,
      tokenInfo.amount,
      pkp.ethAddress
    );
    const signedTx = await createAndSignTransaction(
      params.tokenIn,
      params.recipientAddress,
      tokenInfo.amount,
      gasLimit,
      gasData,
      params.chainId,
      pkp.publicKey
    );

    const result = await broadcastTransaction(provider, signedTx);
    // Try to parse the result
    let parsedResult;
    try {
      parsedResult = JSON.parse(result);
    } catch {
      // If it's not JSON, assume it's a transaction hash
      parsedResult = result;
    }

    // Check if result is an error object
    if (typeof parsedResult === 'object' && parsedResult.error) {
      throw new Error(parsedResult.message);
    }

    // At this point, result should be a transaction hash
    if (!parsedResult) {
      throw new Error('Transaction failed: No transaction hash returned');
    }

    if (!ethers.utils.isHexString(parsedResult)) {
      throw new Error(
        `Transaction failed: Invalid transaction hash format. Received: ${JSON.stringify(
          parsedResult
        )}`
      );
    }

    Lit.Actions.setResponse({
      response: JSON.stringify({
        status: 'success',
        transferHash: parsedResult,
      }),
    });
  } catch (err: any) {
    console.error('Error:', err);

    // Extract detailed error information
    const errorDetails = {
      message: err.message,
      code: err.code,
      reason: err.reason,
      error: err.error,
      ...(err.transaction && { transaction: err.transaction }),
      ...(err.receipt && { receipt: err.receipt }),
    };

    // Construct a detailed error message
    const errorMessage = err.message || String(err);

    Lit.Actions.setResponse({
      response: JSON.stringify({
        status: 'error',
        error: errorMessage,
        details: errorDetails,
      }),
    });
  }
})();
