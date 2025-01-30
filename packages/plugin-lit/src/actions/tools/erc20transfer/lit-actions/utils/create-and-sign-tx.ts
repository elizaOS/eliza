/**
 * Creates and signs the transaction.
 * @param {any} gasLimit - The gas limit for the transaction.
 * @param {any} amount - The amount to transfer.
 * @param {any} gasData - Gas data (maxFeePerGas, maxPriorityFeePerGas, nonce).
 * @returns {Promise<string>} The signed transaction.
 */
export const createAndSignTransaction = async (
  tokenIn: string,
  recipientAddress: string,
  amount: any,
  gasLimit: any,
  gasData: any,
  chainId: string,
  pkpPublicKey: string
) => {
  console.log(`Creating and signing transaction...`);

  const tokenInterface = new ethers.utils.Interface([
    'function transfer(address to, uint256 amount) external returns (bool)',
  ]);

  const transferTx = {
    to: tokenIn,
    data: tokenInterface.encodeFunctionData('transfer', [
      recipientAddress,
      amount,
    ]),
    value: '0x0',
    gasLimit: gasLimit.toHexString(),
    maxFeePerGas: gasData.maxFeePerGas,
    maxPriorityFeePerGas: gasData.maxPriorityFeePerGas,
    nonce: gasData.nonce,
    chainId: chainId,
    type: 2,
  };

  console.log(`Signing transfer with PKP public key: ${pkpPublicKey}...`);
  const transferSig = await Lit.Actions.signAndCombineEcdsa({
    toSign: ethers.utils.arrayify(
      ethers.utils.keccak256(ethers.utils.serializeTransaction(transferTx))
    ),
    publicKey: pkpPublicKey.startsWith('0x')
      ? pkpPublicKey.slice(2)
      : pkpPublicKey,
    sigName: 'erc20TransferSig',
  });

  console.log(`Transaction signed`);

  return ethers.utils.serializeTransaction(
    transferTx,
    ethers.utils.joinSignature({
      r: '0x' + JSON.parse(transferSig).r.substring(2),
      s: '0x' + JSON.parse(transferSig).s,
      v: JSON.parse(transferSig).v,
    })
  );
};
