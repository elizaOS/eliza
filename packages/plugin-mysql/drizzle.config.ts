import { config } from 'dotenv';
import { defineConfig } from 'drizzle-kit';

config({ path: '../../.env' });

export default defineConfig({
  dialect: 'mysql',
  schema: './src/schema/index.ts',
  out: './drizzle/migrations',
  migrations: {
    schema: 'public',
  },
  dbCredentials: {
    url: process.env.MYSQL_URL || '',
  },
  breakpoints: true,
});
