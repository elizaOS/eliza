const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

const isLocalDev =
  process.env.DEPLOYMENT_ENV === 'localnet' ||
  process.env.NODE_ENV === 'development' ||
  !process.env.DIRECT_DATABASE_URL;

const LOCAL_DATABASE_URL =
  'postgresql://babylon:babylon_dev_password@localhost:5433/babylon';

// In non-local environments, require explicit database URL - never fall back to localhost
const databaseUrl = isLocalDev
  ? process.env.DATABASE_URL || LOCAL_DATABASE_URL
  : process.env.DIRECT_DATABASE_URL || process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error(
    'Missing DIRECT_DATABASE_URL or DATABASE_URL in non-local environment. ' +
      'Refusing to default to LOCAL_DATABASE_URL to prevent accidental migrations against wrong database.'
  );
}

/** @type {import('drizzle-kit').Config} */
module.exports = {
  // NOTE: Keep `schema`/`out` as relative paths.
  // Drizzle Kit currently mis-resolves absolute paths by prefixing them with `./`,
  // which breaks reading existing snapshots under `drizzle/migrations/meta/*`.
  // These scripts are run with `--cwd packages/db`, so relative paths are stable.
  // eliza.ts is listed separately — see drizzle.config.ts for the full explanation.
  schema: ['./src/schema/index.ts', './src/schema/eliza.ts'],
  out: './drizzle/migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: databaseUrl,
  },
  verbose: true,
  strict: true,
};
