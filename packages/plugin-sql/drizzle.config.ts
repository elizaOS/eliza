import { config } from 'dotenv';
import { defineConfig } from 'drizzle-kit';

config({ path: '../../.env' });

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema/index.ts',
  out: './drizzle/migrations',
  dbCredentials: {
    url: 'postgresql://postgres:postgres@localhost:5555/eliza2',
  },
  breakpoints: true,
});
