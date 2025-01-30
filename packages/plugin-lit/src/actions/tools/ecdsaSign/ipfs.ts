import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync } from 'fs';

// Define __dirname using import.meta.url
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Default development CIDs for different environments.
 * @type {Object.<string, NetworkCids>}
 * @property {NetworkCids} datil-dev - CIDs for the development environment.
 * @property {NetworkCids} datil-test - CIDs for the test environment.
 * @property {NetworkCids} datil - CIDs for the production environment.
 */
const DEFAULT_CIDS = {
  'datil-dev': {
    tool: 'QmZJovPgBBBmuLKRtdVwdV47opNSmLiV2AZCNTtWzeog1Q',
    defaultPolicy: 'QmPaViiSPUVViC2VkTn3PiRWpkqxnh44BxNY8TcHsuTpJi',
  },
  'datil-test': {
    tool: 'QmZbVUwomfUfCa38ia69LrSfH1k8JNK3BHeSUKm5tGMWgv',
    defaultPolicy: 'QmPaViiSPUVViC2VkTn3PiRWpkqxnh44BxNY8TcHsuTpJi',
  },
  datil: {
    tool: 'QmPjxnXWSPYGYR2gZyiZHpRE7dMAeb7K181R4Cfvkw5KM8',
    defaultPolicy: 'QmPaViiSPUVViC2VkTn3PiRWpkqxnh44BxNY8TcHsuTpJi',
  },
} as const;

/**
 * Tries to read the IPFS CIDs from the build output.
 * Falls back to default development CIDs if the file is not found or cannot be read.
 * @type {Record<keyof typeof DEFAULT_CIDS, NetworkCids>}
 */
let deployedCids = DEFAULT_CIDS;

const ipfsPath = join(__dirname, '../../../dist/ipfs.json');
if (existsSync(ipfsPath)) {
  try {
    // Use dynamic import to load the JSON file
    const ipfsModule = await import(ipfsPath, {
      assert: { type: 'json' }
    });
    deployedCids = ipfsModule.default;
  } catch (error) {
    console.warn('Failed to load ipfs.json, using default CIDs:', error);
  }
} else {
  console.warn(
    'ipfs.json not found. Using default CIDs. You should run `npx nx deploy:lit-action` to update the ipfs.json files.'
  );
}

/**
 * IPFS CIDs for each network's Lit Action.
 * @type {Record<keyof typeof DEFAULT_CIDS, NetworkCids>}
 */
export const IPFS_CIDS = deployedCids;
