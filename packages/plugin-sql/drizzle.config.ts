import fs from 'fs';
import { config } from 'dotenv';
import { defineConfig } from 'drizzle-kit';

// check if .env, ../.env or ../../.env exists exists and load it

const envPath = ['.env', '../.env', '../../.env'].find((path) => fs.existsSync(path));

config({ path: envPath });

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema/index.ts',
  out: './drizzle/migrations',
  dbCredentials: {
    url: process.env.POSTGRES_URL || process.env.PGLITE_DATA_DIR || 'file:../../.elizadb',
  },
  breakpoints: true,
});
