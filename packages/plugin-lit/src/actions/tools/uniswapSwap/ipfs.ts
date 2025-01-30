import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync } from 'fs';

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
    tool: 'QmQPUjXmFiAe363TYAiv3DPciyTDSFLym2S9FR1d78ZRWs',
    defaultPolicy: 'Qmc6RAbV3WAqfNLvkAxp4hYjd4TDim4PwjWyhGbM9X7nbR',
  },
  'datil-test': {
    tool: 'QmaLAZCJEk5B4BW962pjENxCDHvwGtPptCamhckk9GJxJe',
    defaultPolicy: 'Qmc6RAbV3WAqfNLvkAxp4hYjd4TDim4PwjWyhGbM9X7nbR',
  },
  datil: {
    tool: 'QmStLtPzAvyUAQXbkUorZUJ7mgst6tU4xhJoFYHMZp9etH',
    defaultPolicy: 'Qmc6RAbV3WAqfNLvkAxp4hYjd4TDim4PwjWyhGbM9X7nbR',
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
