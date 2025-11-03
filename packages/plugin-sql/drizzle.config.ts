import { config } from 'dotenv';
import { defineConfig } from 'drizzle-kit';

config({ path: '../../.env' });

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema/index.ts',
  out: './drizzle/migrations',
  dbCredentials: {
    url: process.env.POSTGRES_URL || 'file:../../.eliza/.elizadb',
  },
  breakpoints: true,
});
