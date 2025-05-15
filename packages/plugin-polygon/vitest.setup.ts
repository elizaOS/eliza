import dotenv from 'dotenv';
import path from 'node:path';

// Resolve the path to the root .env file from packages/plugin-polygon/vitest.setup.ts
// __dirname in this context should be packages/plugin-polygon/
// So, ../../.env should point to the root
const workspaceRoot = path.resolve(__dirname, '../../');
const envPath = path.resolve(workspaceRoot, '.env');

console.log(`Vitest setup: Attempting to load .env from: ${envPath}`);
const result = dotenv.config({ path: envPath });

if (result.error) {
  // It's a warning because the .env file might not exist in all CI environments
  console.warn(`Vitest setup: Warning - Error loading .env from ${envPath}:`, result.error.message);
} else {
  if (result.parsed && Object.keys(result.parsed).length > 0) {
    console.log(`Vitest setup: .env file loaded successfully from ${envPath}.`);
  } else if (!process.env.POLYGONSCAN_KEY && !process.env.POLYGON_RPC_URL) {
    // If not parsed, it might be empty or already loaded through other means (e.g. CI secrets)
    // Only warn if critical vars are definitely missing after the attempt.
    console.warn(
      `Vitest setup: .env file at ${envPath} might be empty or critical variables (POLYGONSCAN_KEY, POLYGON_RPC_URL) not found after loading attempt.`
    );
  } else {
    console.log(
      `Vitest setup: .env file at ${envPath} was processed. Variables might have been already set or the file is empty.`
    );
  }
}

// For quick verification during test runs:
// console.log(`Vitest setup: POLYGONSCAN_KEY is ${process.env.POLYGONSCAN_KEY ? 'Loaded' : 'NOT LOADED'}`);
// console.log(`Vitest setup: POLYGON_RPC_URL is ${process.env.POLYGON_RPC_URL ? 'Loaded' : 'NOT LOADED'}`);
