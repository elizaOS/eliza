import 'dotenv/config';
import fs from 'fs';
import path from 'path';

console.log('Environment Variables Check');
console.log('=========================\n');

// Check SOLANA_PRIVATE_KEY
const privateKey = process.env.SOLANA_PRIVATE_KEY;
if (privateKey) {
  console.log('✅ SOLANA_PRIVATE_KEY is set');
  console.log(`   Length: ${privateKey.length} characters`);
  console.log(`   First 10 chars: ${privateKey.substring(0, 10)}...`);
} else {
  console.log('❌ SOLANA_PRIVATE_KEY is NOT set');
}

// Check BIRDEYE_API_KEY
const birdeyeKey = process.env.BIRDEYE_API_KEY;
if (birdeyeKey) {
  console.log('✅ BIRDEYE_API_KEY is set');
  console.log(`   Length: ${birdeyeKey.length} characters`);
} else {
  console.log('❌ BIRDEYE_API_KEY is NOT set');
}

// Check SOLANA_ADDRESS
const address = process.env.SOLANA_ADDRESS;
if (address) {
  console.log('✅ SOLANA_ADDRESS is set');
  console.log(`   Address: ${address}`);
} else {
  console.log('⚠️  SOLANA_ADDRESS is NOT set (optional)');
}

// Check SOLANA_RPC_URL
const rpcUrl = process.env.SOLANA_RPC_URL;
if (rpcUrl) {
  console.log('✅ SOLANA_RPC_URL is set');
  console.log(`   URL: ${rpcUrl}`);
} else {
  console.log('⚠️  SOLANA_RPC_URL is NOT set (will use default)');
}

// Check .env file location
console.log('\n.env File Check:');
console.log('================');

const envPath = path.join(process.cwd(), '.env');
if (fs.existsSync(envPath)) {
  console.log(`✅ .env file found at: ${envPath}`);

  // Read and parse .env file to check format
  const envContent = fs.readFileSync(envPath, 'utf8');
  const lines = envContent
    .split('\n')
    .filter((line: string) => line.trim() && !line.startsWith('#'));

  console.log(`   Contains ${lines.length} non-comment lines`);

  // Check for common issues
  const hasPrivateKey = lines.some((line: string) => line.startsWith('SOLANA_PRIVATE_KEY='));
  const hasBirdeyeKey = lines.some((line: string) => line.startsWith('BIRDEYE_API_KEY='));

  if (hasPrivateKey) {
    console.log('   ✅ SOLANA_PRIVATE_KEY line found in .env');
  } else {
    console.log('   ❌ SOLANA_PRIVATE_KEY line NOT found in .env');
  }

  if (hasBirdeyeKey) {
    console.log('   ✅ BIRDEYE_API_KEY line found in .env');
  } else {
    console.log('   ❌ BIRDEYE_API_KEY line NOT found in .env');
  }
} else {
  console.log(`❌ .env file NOT found at: ${envPath}`);
}

console.log('\nCurrent working directory:', process.cwd());
