/**
 * Signs a transaction using the PKP's public key.
 * @param {any} tx - The transaction to sign.
 * @param {string} sigName - The name of the signature.
 * @returns {Promise<string>} The signed transaction.
 */
export const signTx = async (
  pkpPublicKey: string,
  tx: any,
  sigName: string
) => {
  console.log(`Signing TX: ${sigName}`);
  const pkForLit = pkpPublicKey.startsWith('0x')
    ? pkpPublicKey.slice(2)
    : pkpPublicKey;

  const sig = await Lit.Actions.signAndCombineEcdsa({
    toSign: ethers.utils.arrayify(
      ethers.utils.keccak256(ethers.utils.serializeTransaction(tx))
    ),
    publicKey: pkForLit,
    sigName,
  });

  return ethers.utils.serializeTransaction(
    tx,
    ethers.utils.joinSignature({
      r: '0x' + JSON.parse(sig).r.substring(2),
      s: '0x' + JSON.parse(sig).s,
      v: JSON.parse(sig).v,
    })
  );
};
