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
    message: string;
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

  // Get allowed prefixes from policy parameters
  const policyParameters = await getPolicyParameters(
    pkpToolRegistryContract,
    pkpTokenId,
    parentToolIpfsCid,
    delegateeAddress,
    ['allowedPrefixes']
  );

  // Extract and parse allowedPrefixes
  const allowedPrefixesParam = policyParameters.find(
    (p: { name: string; value: Uint8Array }) => p.name === 'allowedPrefixes'
  );
  if (!allowedPrefixesParam) {
    throw new Error('No allowedPrefixes parameter found in policy');
  }

  const allowedPrefixes: string[] = JSON.parse(
    ethers.utils.toUtf8String(allowedPrefixesParam.value)
  );
  if (!allowedPrefixes.length) {
    throw new Error('No allowed prefixes defined in policy');
  }

  // Check if message starts with any allowed prefix
  const messageHasAllowedPrefix = allowedPrefixes.some((prefix) =>
    toolParameters.message.startsWith(prefix)
  );

  if (!messageHasAllowedPrefix) {
    throw new Error(
      `Message must start with one of these prefixes: ${allowedPrefixes.join(
        ', '
      )}`
    );
  }

  console.log('Message prefix validated successfully');
})();
