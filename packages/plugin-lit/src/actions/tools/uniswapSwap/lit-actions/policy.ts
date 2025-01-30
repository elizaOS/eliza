import {
  checkLitAuthAddressIsDelegatee,
  getPkpToolRegistryContract,
  getPolicyParameters,
} from '@lit-protocol/aw-tool';

declare global {
  // Required Inputs
  const parentToolIpfsCid: string;
  const pkpToolRegistryContractAddress: string;
  const pkpTokenId: string;
  const delegateeAddress: string;
  const toolParameters: {
    amountIn: string;
    tokenIn: string;
    tokenOut: string;
  };
}

(async () => {
  const pkpToolRegistryContract = await getPkpToolRegistryContract(
    pkpToolRegistryContractAddress
  );

  const isDelegatee = await checkLitAuthAddressIsDelegatee(
    pkpToolRegistryContract,
    pkpTokenId
  );
  if (!isDelegatee) {
    throw new Error(
      `Session signer ${ethers.utils.getAddress(
        LitAuth.authSigAddress
      )} is not a delegatee for PKP ${pkpTokenId}`
    );
  }

  const policyParameters = await getPolicyParameters(
    pkpToolRegistryContract,
    pkpTokenId,
    parentToolIpfsCid,
    delegateeAddress,
    ['maxAmount', 'allowedTokens']
  );

  let maxAmount: any;
  let allowedTokens: string[] = [];

  console.log(
    `Retrieved policy parameters: ${JSON.stringify(policyParameters)}`
  );

  for (const parameter of policyParameters) {
    const value = ethers.utils.toUtf8String(parameter.value);

    switch (parameter.name) {
      case 'maxAmount':
        maxAmount = ethers.BigNumber.from(value);
        console.log(`Formatted maxAmount: ${maxAmount.toString()}`);
        break;
      case 'allowedTokens':
        allowedTokens = JSON.parse(value);
        allowedTokens = allowedTokens.map((addr: string) =>
          ethers.utils.getAddress(addr)
        );
        console.log(`Formatted allowedTokens: ${allowedTokens.join(', ')}`);
        break;
    }
  }

  // Convert string amount to BigNumber and compare
  const amountBN = ethers.BigNumber.from(toolParameters.amountIn);
  console.log(
    `Checking if amount ${amountBN.toString()} exceeds maxAmount ${maxAmount.toString()}...`
  );

  if (amountBN.gt(maxAmount)) {
    throw new Error(
      `Amount ${ethers.utils.formatUnits(
        amountBN
      )} exceeds the maximum amount ${ethers.utils.formatUnits(maxAmount)}`
    );
  }

  if (allowedTokens.length > 0) {
    console.log(`Checking if ${toolParameters.tokenIn} is an allowed token...`);
    if (
      !allowedTokens.includes(ethers.utils.getAddress(toolParameters.tokenIn))
    ) {
      throw new Error(
        `Token ${
          toolParameters.tokenIn
        } not allowed. Allowed tokens: ${allowedTokens.join(', ')}`
      );
    }

    console.log(
      `Checking if ${toolParameters.tokenOut} is an allowed token...`
    );
    if (
      !allowedTokens.includes(ethers.utils.getAddress(toolParameters.tokenOut))
    ) {
      throw new Error(
        `Token ${
          toolParameters.tokenOut
        } not allowed. Allowed tokens: ${allowedTokens.join(', ')}`
      );
    }
  }

  console.log('Policy parameters validated');
})();
