import {
  checkLitAuthAddressIsDelegatee,
  getPolicyParameters,
  getPkpToolRegistryContract,
} from '@lit-protocol/aw-tool';

declare global {
  // Required Inputs
  const parentToolIpfsCid: string;
  const pkpToolRegistryContractAddress: string;
  const pkpTokenId: string;
  const delegateeAddress: string;
  const tokenInfo: {
    amount: string;
    tokenAddress: string;
    recipientAddress: string;
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
    ['maxAmount', 'allowedTokens', 'allowedRecipients']
  );

  let maxAmount: any;
  let allowedTokens: string[] = [];
  let allowedRecipients: string[] = [];

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
      case 'allowedRecipients':
        allowedRecipients = JSON.parse(value);
        allowedRecipients = allowedRecipients.map((addr: string) =>
          ethers.utils.getAddress(addr)
        );
        console.log(
          `Formatted allowedRecipients: ${allowedRecipients.join(', ')}`
        );
        break;
    }
  }

  // Convert string amount to BigNumber and compare
  const amountBN = ethers.BigNumber.from(tokenInfo.amount);
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
    console.log(`Checking if ${tokenInfo.tokenAddress} is an allowed token...`);

    if (
      !allowedTokens.includes(ethers.utils.getAddress(tokenInfo.tokenAddress))
    ) {
      throw new Error(
        `Token ${
          tokenInfo.tokenAddress
        } not allowed. Allowed tokens: ${allowedTokens.join(', ')}`
      );
    }
  }

  if (allowedRecipients.length > 0) {
    console.log(
      `Checking if ${tokenInfo.recipientAddress} is an allowed recipient...`
    );

    if (
      !allowedRecipients.includes(
        ethers.utils.getAddress(tokenInfo.recipientAddress)
      )
    ) {
      throw new Error(
        `Recipient ${
          tokenInfo.recipientAddress
        } not allowed. Allowed recipients: ${allowedRecipients.join(', ')}`
      );
    }
  }

  console.log('Policy parameters validated');
})();
