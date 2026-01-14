import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';

// Extract public key from private key
function extractPublicKey() {
  const privateKey = process.env.SOLANA_PRIVATE_KEY;

  if (!privateKey) {
    console.error('❌ SOLANA_PRIVATE_KEY not found in environment');
    console.log('\nSet it in your .env file:');
    console.log('SOLANA_PRIVATE_KEY=your_base58_private_key_here');
    return;
  }

  try {
    const decoded = bs58.decode(privateKey);
    const keypair = Keypair.fromSecretKey(decoded);
    const publicKey = keypair.publicKey.toBase58();

    console.log('✅ Public Key Extracted Successfully!\n');
    console.log(`Public Key: ${publicKey}`);
    console.log('\nAdd this to your .env file:');
    console.log(`SOLANA_ADDRESS=${publicKey}`);
  } catch (error) {
    console.error('❌ Failed to decode private key:', error);
    console.log('\nMake sure your SOLANA_PRIVATE_KEY is a valid base58 encoded private key');
  }
}

extractPublicKey();
