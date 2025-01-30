/**
 * Signs the message using the PKP's public key.
 * @param pkpPublicKey - The PKP's public key.
 * @param message - The message to sign.
 * @returns The signature of the message.
 */
export const signMessage = async (pkpPublicKey: string, message: string) => {
  const pkForLit = pkpPublicKey.startsWith('0x')
    ? pkpPublicKey.slice(2)
    : pkpPublicKey;

  const sig = await Lit.Actions.signEcdsa({
    toSign: ethers.utils.arrayify(
      ethers.utils.keccak256(ethers.utils.toUtf8Bytes(message))
    ),
    publicKey: pkForLit,
    sigName: 'sig',
  });

  return sig;
};
