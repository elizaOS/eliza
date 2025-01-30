// pnpm install @ton/ton @ton/crypto
import { mnemonicNew, KeyPair, mnemonicToPrivateKey } from '@ton/crypto';
import { WalletContractV4 } from "@ton/ton";

async function start() {
  const amount = 2;
  const password = '';

  const keyPairs = await Promise.all(Array.from({ length: amount }).map(async () => {
    const mnemonics: string[] = await mnemonicNew(24, password);
    const pair: KeyPair = await mnemonicToPrivateKey(mnemonics, password);
    const wallet = WalletContractV4.create({ workchain: 0, publicKey: pair.publicKey });
    const formattedAddress = wallet.address.toString({ bounceable: false, urlSafe: true });

    return { mnemonic: mnemonics.join(' '), address: formattedAddress, version: 'v4', publicKeyHash: pair.publicKey.toString('hex') };
  }));

  console.log(keyPairs)
  console.log(new Date().toISOString());
}

start()
  .then(() => console.log("Done"))
  .catch((err) => console.error(err));
