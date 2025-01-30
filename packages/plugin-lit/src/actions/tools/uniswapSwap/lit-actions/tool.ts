import {
  fetchToolPolicyFromRegistry,
  getPkpInfo,
  getPkpToolRegistryContract,
  NETWORK_CONFIG,
} from '@lit-protocol/aw-tool';

import {
  getUniswapQuoterRouter,
  getTokenInfo,
  getBestQuote,
  getGasData,
  estimateGasLimit,
  createTransaction,
  signTx,
  broadcastTransaction,
} from './utils';

declare global {
  // Required Inputs
  const params: {
    pkpEthAddress: string;
    rpcUrl: string;
    chainId: string;
    tokenIn: string;
    tokenOut: string;
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

    const { UNISWAP_V3_QUOTER, UNISWAP_V3_ROUTER } = getUniswapQuoterRouter(
      params.chainId
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
      params.amountIn,
      params.tokenOut,
      pkp
    );

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

      await Lit.Actions.call({
        ipfsId: toolPolicy.policyIpfsCid,
        params: {
          parentToolIpfsCid: toolIpfsCid,
          pkpToolRegistryContractAddress: PKP_TOOL_REGISTRY_ADDRESS,
          pkpTokenId: pkp.tokenId,
          delegateeAddress,
          toolParameters: {
            amountIn: tokenInfo.tokenIn.amount.toString(),
            tokenIn: params.tokenIn,
            tokenOut: params.tokenOut,
          },
        },
      });
    } else {
      console.log(
        `No policy found for tool ${toolIpfsCid} on PKP ${pkp.tokenId} for delegatee ${delegateeAddress}`
      );
    }

    // Get best quote and calculate minimum output
    const { bestFee, amountOutMin } = await getBestQuote(
      provider,
      UNISWAP_V3_QUOTER,
      tokenInfo.tokenIn.amount,
      tokenInfo.tokenOut.decimals
    );

    // Get gas data for transactions
    const gasData = await getGasData(provider, pkp.ethAddress);

    // Approval Transaction
    const approvalGasLimit = await estimateGasLimit(
      provider,
      pkp.ethAddress,
      UNISWAP_V3_ROUTER,
      tokenInfo.tokenIn.contract,
      tokenInfo.tokenIn.amount,
      true
    );

    const approvalTx = await createTransaction(
      UNISWAP_V3_ROUTER,
      pkp.ethAddress,
      approvalGasLimit,
      tokenInfo.tokenIn.amount,
      gasData,
      true
    );

    const signedApprovalTx = await signTx(
      pkp.publicKey,
      approvalTx,
      'erc20ApprovalSig'
    );
    const approvalHash = await broadcastTransaction(provider, signedApprovalTx);
    console.log('Approval transaction hash:', approvalHash);

    // Wait for approval confirmation
    console.log('Waiting for approval confirmation...');
    const approvalConfirmation = await provider.waitForTransaction(
      approvalHash,
      1
    );
    if (approvalConfirmation.status === 0) {
      throw new Error('Approval transaction failed');
    }

    // Swap Transaction
    const swapGasLimit = await estimateGasLimit(
      provider,
      UNISWAP_V3_ROUTER,
      pkp.ethAddress,
      tokenInfo.tokenIn.contract,
      tokenInfo.tokenIn.amount,
      false,
      { fee: bestFee, amountOutMin }
    );

    const swapTx = await createTransaction(
      UNISWAP_V3_ROUTER,
      pkp.ethAddress,
      swapGasLimit,
      tokenInfo.tokenIn.amount,
      { ...gasData, nonce: gasData.nonce + 1 },
      false,
      { fee: bestFee, amountOutMin }
    );

    const signedSwapTx = await signTx(pkp.publicKey, swapTx, 'erc20SwapSig');
    const swapHash = await broadcastTransaction(provider, signedSwapTx);
    console.log('Swap transaction hash:', swapHash);

    Lit.Actions.setResponse({
      response: JSON.stringify({
        status: 'success',
        approvalHash,
        swapHash,
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

    Lit.Actions.setResponse({
      response: JSON.stringify({
        status: 'error',
        error: err.message || String(err),
        details: errorDetails,
      }),
    });
  }
})();
